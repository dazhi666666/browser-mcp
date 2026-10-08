import { randomUUID } from "node:crypto";
import type http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserCommand, BrowserCommandResult } from "../shared/index.js";
import type { AgentScope, TabManager } from "./tabManager.js";
import { logger } from "./logger.js";

type Execute = (command: BrowserCommand, scope: AgentScope) => Promise<BrowserCommandResult>;

/**
 * 一个 MCP session 的默认分组身份（对应 ZCode 的 sessionId/workspaceKey scope）。
 * client 取自 initialize 的 clientInfo.name 或 x-bmcp-client 头；
 * thread 优先级：单条调用的 group 参数 > browser_scope 设置 > x-bmcp-group 头 > sessionId。
 */
interface SessionScopeCtx {
  /** transport 协商出的 MCP session id（onsessioninitialized 后填入）。 */
  id?: string;
  client: string;
  headerGroup?: string;
  threadOverride?: string;
  label?: string;
  /** 本 session 实际寻址过的 thread（含逐调用 group 覆盖），close 时据此释放分组。 */
  usedThreads: Set<string>;
  /** 存活信号：客户端 close/断网不会发 DELETE，靠 standalone SSE 断开+宽限判定死亡。 */
  lastSeen: number;
  sseEverOpened: boolean;
  /** 当前挂起的 standalone SSE GET 响应；关断时置空并记 sseClosedAt。 */
  sseRes?: http.ServerResponse;
  sseClosedAt?: number;
}

/** SSE 断开后的宽限期：SDK 客户端 transient 重连用，过了才算 session 死亡。 */
const ORPHAN_GRACE_MS = Number(process.env.BROWSER_MCP_ORPHAN_GRACE_MS ?? 15_000);
/** 从不挂 SSE 的纯 POST 客户端的兜底存活时长。 */
const IDLE_TTL_MS = Number(process.env.BROWSER_MCP_SESSION_TTL_MS ?? 30 * 60_000);

const tabId = z.string().optional().describe("Target tab id; defaults to the active tab");
const modifiers = z
  .array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]))
  .optional();
const point = z.object({ x: z.number(), y: z.number() }).strict();

function describe(command: BrowserCommand): string {
  return command.method + (("tabId" in command && command.tabId) ? ` tab=${command.tabId}` : "");
}

/**
 * 把 BrowserCommandResult 收敛为 MCP tool result。
 * 截图走 image content；其余统一 text JSON（去掉 elapsedMs 噪音）。
 */
function toToolResult(result: BrowserCommandResult, label: string) {
  if (!result.ok) {
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: `${label} failed: ${result.error?.code ?? "error"}: ${result.error?.message ?? "unknown"}`,
        },
      ],
    };
  }
  const { elapsedMs: _elapsed, ...rest } = result as Record<string, unknown>;
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  const image = rest.image as { base64?: string; mimeType?: string } | undefined;
  if (image?.base64) {
    content.push({
      type: "image",
      data: image.base64,
      mimeType: image.mimeType ?? "image/png",
    });
    delete rest.image;
  }
  content.push({ type: "text", text: JSON.stringify(rest) });
  return { content };
}

function registerCommandTool(
  server: McpServer,
  execute: Execute,
  scopeFor: (group?: string) => AgentScope,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  build: (args: any) => BrowserCommand,
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: {
        ...inputSchema,
        // 每个工具都可临时覆盖分组（thread）身份：共享同一 MCP session 的多个
        // 对话线程可借此保持各自分组独立。
        group: z
          .string()
          .optional()
          .describe("Tab group / thread identity override for this call"),
      },
    } as never,
    (async (args: any) => {
      const command = build(args);
      logger.debug(`[mcp] ${name} -> ${describe(command)}`);
      const result = await execute(command, scopeFor(args?.group));
      return toToolResult(result, name);
    }) as never,
  );
}

export function createBrowserMcpServer(
  execute: Execute,
  ctx: SessionScopeCtx,
  tabManager: TabManager,
): McpServer {
  const server = new McpServer(
    { name: "browser-mcp", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );
  const scopeFor = (group?: string): AgentScope => {
    const thread =
      (group ?? ctx.threadOverride ?? ctx.headerGroup ?? ctx.id ?? "default").trim() || "default";
    ctx.usedThreads.add(thread);
    return {
      client: ctx.client,
      thread,
      ...(ctx.label ? { label: ctx.label } : {}),
    };
  };
  const reg = (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    build: (args: any) => BrowserCommand,
  ) => registerCommandTool(server, execute, scopeFor, name, description, inputSchema, build);

  // ---- 导航 ----
  reg(
    "browser_navigate",
    "Navigate a browser tab to a URL",
    { url: z.string().min(1), tabId },
    (a: { url: string; tabId?: string }) => ({
      method: "navigate",
      url: a.url,
      tabId: a.tabId,
    }),
  );
  for (const method of ["back", "forward", "reload"] as const) {
    reg(`browser_${method}`, `Go ${method} in tab history`, { tabId }, (a: {
      tabId?: string;
    }) => ({ method, tabId: a.tabId }));
  }

  // ---- 读取 ----
  reg(
    "browser_snapshot",
    "Capture the interactive element snapshot (refs e1..eN) of the page. Use the refs with click/type/fill/etc.",
    {
      tabId,
      maxElements: z.number().int().positive().optional(),
      includeHidden: z.boolean().optional(),
    },
    (a: { tabId?: string; maxElements?: number; includeHidden?: boolean }) => ({
      method: "snapshot",
      maxElements: a.maxElements,
      includeHidden: a.includeHidden,
      tabId: a.tabId,
    }),
  );
  reg(
    "browser_dom_snapshot",
    "Capture a Playwright-style ARIA accessibility tree snapshot of the page (text outline)",
    { tabId },
    (a: { tabId?: string }) => ({
      method: "playwright",
      action: { name: "domSnapshot" },
      tabId: a.tabId,
    }),
  );
  reg(
    "browser_take_screenshot",
    "Take a PNG screenshot of the page viewport (optionally full page / clip region / element ref)",
    {
      tabId,
      ref: z.string().optional(),
      fullPage: z.boolean().optional(),
      clip: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .strict()
        .optional(),
    },
    (a) => ({
      method: "screenshot",
      ref: a.ref,
      fullPage: a.fullPage,
      clip: a.clip,
      tabId: a.tabId,
    }),
  );
  reg("browser_get_state", "Get current tab url/title/navigation state", { tabId }, (a) => ({
    method: "getState",
    tabId: a.tabId,
  }));
  reg(
    "browser_element_info",
    "Return element info (role/name/rect/selector) at viewport coordinates",
    { x: z.number(), y: z.number(), tabId },
    (a) => ({ method: "elementInfo", x: a.x, y: a.y, tabId: a.tabId }),
  );
  reg(
    "browser_evaluate",
    "Evaluate a JavaScript expression in the page and return the JSON-serializable result",
    { expression: z.string().min(1), tabId },
    (a) => ({ method: "evaluate", expression: a.expression, tabId: a.tabId }),
  );
  reg(
    "browser_download",
    "Download a URL to a local file with the browser session's cookies (reuses institutional/library logins instead of in-page fetch). " +
      "Returns download: { path, bytes, mimeType, filename }.",
    {
      url: z.string().min(1),
      path: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute target path, or a filename saved into the system Downloads folder; defaults to the URL's basename"),
      tabId,
    },
    (a: { url: string; path?: string; tabId?: string }) => ({
      method: "download",
      url: a.url,
      path: a.path,
      tabId: a.tabId,
    }),
  );

  // ---- 交互 ----
  reg(
    "browser_click",
    "Click an element by snapshot ref or viewport coordinates",
    {
      ref: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      doubleClick: z.boolean().optional(),
      modifiers,
      tabId,
    },
    (a) => ({
      method: "click",
      ref: a.ref,
      x: a.x,
      y: a.y,
      button: a.button,
      doubleClick: a.doubleClick,
      modifiers: a.modifiers,
      tabId: a.tabId,
    }),
  );
  reg(
    "browser_type",
    "Type text into the focused element or into the element identified by ref",
    { text: z.string(), ref: z.string().optional(), tabId },
    (a) => ({ method: "type", text: a.text, ref: a.ref, tabId: a.tabId }),
  );
  reg(
    "browser_fill",
    "Set the value of an input/textarea/select identified by snapshot ref (fires input+change)",
    { ref: z.string(), value: z.string(), tabId },
    (a) => ({ method: "fill", ref: a.ref, value: a.value, tabId: a.tabId }),
  );
  reg(
    "browser_press",
    "Press a single key (optionally focused via ref, with modifiers)",
    { key: z.string(), ref: z.string().optional(), modifiers, tabId },
    (a) => ({
      method: "press",
      key: a.key,
      ref: a.ref,
      modifiers: a.modifiers,
      tabId: a.tabId,
    }),
  );
  reg(
    "browser_keypress",
    "Press a key combination, e.g. ['Control','A'] — real OS-level order preserved",
    { keys: z.array(z.string().min(1)).min(1), tabId },
    (a) => ({ method: "cuaKeypress", keys: a.keys, tabId: a.tabId }),
  );
  reg(
    "browser_hover",
    "Hover an element (ref) or viewport point (x,y)",
    { ref: z.string().optional(), x: z.number().optional(), y: z.number().optional(), modifiers, tabId },
    (a) => ({
      method: "hover",
      ref: a.ref,
      x: a.x,
      y: a.y,
      modifiers: a.modifiers,
      tabId: a.tabId,
    }),
  );
  reg(
    "browser_select_option",
    "Select option(s) in a <select> by value or visible text",
    { ref: z.string(), values: z.array(z.string()).min(1), tabId },
    (a) => ({ method: "select", ref: a.ref, values: a.values, tabId: a.tabId }),
  );
  reg(
    "browser_check",
    "Set checked state of a checkbox/radio identified by ref",
    { ref: z.string(), checked: z.boolean().optional(), tabId },
    (a) => ({ method: "check", ref: a.ref, checked: a.checked, tabId: a.tabId }),
  );
  reg(
    "browser_drag",
    "Drag from element/point to element/point, or along an explicit coordinate path",
    {
      fromRef: z.string().optional(),
      toRef: z.string().optional(),
      from: point.optional(),
      to: point.optional(),
      path: z.array(point).min(1).optional(),
      modifiers,
      tabId,
    },
    (a) =>
      a.path
        ? { method: "cuaDrag", path: a.path, modifiers: a.modifiers, tabId: a.tabId }
        : {
            method: "drag",
            fromRef: a.fromRef,
            toRef: a.toRef,
            from: a.from,
            to: a.to,
            modifiers: a.modifiers,
            tabId: a.tabId,
          },
  );
  reg(
    "browser_scroll",
    "Scroll: with ref scrolls element into view; otherwise wheel-scrolls by deltaX/deltaY at viewport point (x,y)",
    {
      ref: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      deltaX: z.number().optional(),
      deltaY: z.number().optional(),
      modifiers,
      tabId,
    },
    (a) =>
      a.ref
        ? { method: "scroll", ref: a.ref, tabId: a.tabId }
        : {
            method: "cuaScroll",
            x: a.x ?? 0,
            y: a.y ?? 0,
            scrollX: a.deltaX ?? 0,
            scrollY: a.deltaY ?? 0,
            modifiers: a.modifiers,
            tabId: a.tabId,
          },
  );

  // ---- 等待 ----
  reg(
    "browser_wait_for",
    "Wait until a CSS selector exists / text appears / text disappears (polls the page)",
    {
      selector: z.string().optional(),
      text: z.string().optional(),
      textGone: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      tabId,
    },
    (a) => ({
      method: "waitFor",
      selector: a.selector,
      text: a.text,
      textGone: a.textGone,
      timeoutMs: a.timeoutMs,
      tabId: a.tabId,
    }),
  );
  reg("browser_wait", "Sleep for a fixed number of milliseconds", { ms: z.number().int().nonnegative(), tabId }, (a) => ({
    method: "playwrightWaitForTimeout",
    timeoutMs: a.ms,
    tabId: a.tabId,
  }));
  reg(
    "browser_wait_for_load_state",
    "Wait for page load state: load | domcontentloaded | networkidle",
    {
      state: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
      tabId,
    },
    (a) => ({
      method: "playwright",
      action: { name: "waitForLoadState", state: a.state, timeoutMs: a.timeoutMs },
      tabId: a.tabId,
    }),
  );
  reg(
    "browser_wait_for_url",
    "Wait until the tab URL matches (string or glob/regex pattern)",
    {
      url: z.string().min(1),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
      tabId,
    },
    (a) => ({
      method: "playwright",
      action: {
        name: "waitForURL",
        url: a.url,
        waitUntil: a.waitUntil,
        timeoutMs: a.timeoutMs,
      },
      tabId: a.tabId,
    }),
  );

  // ---- Dialog ----
  reg(
    "browser_get_dialog",
    "Get the currently pending JavaScript dialog (alert/confirm/prompt/beforeunload), or null",
    { tabId },
    (a) => ({ method: "getDialog", tabId: a.tabId }),
  );
  reg(
    "browser_handle_dialog",
    "Accept or dismiss the pending JavaScript dialog (promptText for prompt())",
    { accept: z.boolean(), promptText: z.string().optional(), tabId },
    (a) => ({
      method: "handleDialog",
      accept: a.accept,
      promptText: a.promptText,
      tabId: a.tabId,
    }),
  );

  // ---- Tabs / surface ----
  server.registerTool(
    "browser_tabs",
    {
      description:
        "Manage tabs: action=list | new | activate | close | claim. " +
        "list returns this group's tabs, claimable user tabs, and orphanTabs " +
        "(tabs left by dead agent sessions — claimable via claim or by " +
        "addressing them with an explicit tabId).",
      inputSchema: {
        action: z.enum(["list", "new", "activate", "close", "claim"]),
        tabId: z.string().optional(),
        url: z.string().optional().describe("initial URL when action=new"),
        group: z
          .string()
          .optional()
          .describe("Tab group / thread identity override for this call"),
      },
    } as never,
    (async (a: {
      action: "list" | "new" | "activate" | "close" | "claim";
      tabId?: string;
      url?: string;
      group?: string;
    }) => {
      const scope = scopeFor(a.group);
      if (a.action === "new") {
        const created = await execute({ method: "newTab" }, scope);
        if (!created.ok) return toToolResult(created, "browser_tabs");
        const newTabId = (created.tab as { tabId?: string } | undefined)?.tabId;
        if (a.url && newTabId) {
          await execute({ method: "navigate", url: a.url, tabId: newTabId }, scope);
        }
        return toToolResult(await execute({ method: "list" }, scope), "browser_tabs");
      }
      const command: BrowserCommand =
        a.action === "activate"
          ? { method: "activateTab", tabId: a.tabId ?? "" }
          : a.action === "claim"
            ? { method: "claimTab", tabId: a.tabId ?? "" }
            : a.action === "close"
              ? { method: "close", tabId: a.tabId }
              : { method: "list" };
      return toToolResult(await execute(command, scope), "browser_tabs");
    }) as never,
  );
  server.registerTool(
    "browser_scope",
    {
      description:
        "Inspect or rename this session's tab group. Tabs created by different " +
        "agent threads are grouped separately in the tab strip; call with " +
        "action=set to give this session a stable group name/label.",
      inputSchema: {
        action: z.enum(["get", "set"]),
        group: z.string().optional().describe("new thread/group id for this session"),
        name: z.string().optional().describe("display label for the group"),
      },
    } as never,
    (async (a: { action: "get" | "set"; group?: string; name?: string }) => {
      if (a.action === "set") {
        const from = scopeFor();
        if (a.group) ctx.threadOverride = a.group.trim() || ctx.threadOverride;
        if (a.name) ctx.label = a.name.trim() || ctx.label;
        const to = scopeFor();
        tabManager.renameScope(from, to);
      }
      const info = tabManager.scopeInfo(scopeFor());
      return {
        content: [{ type: "text" as const, text: JSON.stringify(info) }],
      };
    }) as never,
  );
  reg(
    "browser_resize",
    "Override the page CSS viewport (CDP device metrics; window size unchanged)",
    { width: z.number().int().positive(), height: z.number().int().positive(), tabId },
    (a) => ({
      method: "browserViewportSet",
      width: a.width,
      height: a.height,
      tabId: a.tabId,
    }),
  );
  reg("browser_viewport_reset", "Clear the viewport override", { tabId }, (a) => ({
    method: "browserViewportReset",
    tabId: a.tabId,
  }));
  reg(
    "browser_set_visible",
    "Show or hide the browser window (automation continues while hidden)",
    { visible: z.boolean() },
    (a) => ({ method: "browserVisibilitySet", visible: a.visible }),
  );

  // ---- 高级：locator 透传 ----
  reg(
    "browser_locator",
    "Playwright locator operation on a selector (click/fill/press/selectOption/setChecked/waitFor/count/isVisible/textContent/getAttribute/allTextContents/innerText/evaluate/dblclick/downloadMedia). Selector syntax: playwright (css=, role=, text=, xpath=, ...)",
    {
      selector: z.string().min(1),
      operation: z.enum([
        "allTextContents",
        "click",
        "count",
        "dblclick",
        "downloadMedia",
        "evaluate",
        "fill",
        "getAttribute",
        "innerText",
        "isEnabled",
        "isVisible",
        "press",
        "selectOption",
        "setChecked",
        "textContent",
        "waitFor",
      ]),
      value: z.unknown().optional(),
      arg: z.unknown().optional(),
      expression: z.string().optional(),
      expressionKind: z.enum(["string", "function"]).optional(),
      attribute: z.string().optional(),
      checked: z.boolean().optional(),
      replace: z.boolean().optional(),
      force: z.boolean().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      modifiers,
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      selections: z
        .array(
          z
            .object({
              value: z.string().optional(),
              label: z.string().optional(),
              index: z.number().int().nonnegative().optional(),
            })
            .strict(),
        )
        .min(1)
        .optional(),
      timeoutMs: z.number().int().positive().optional(),
      tabId,
    },
    (a) => ({
      method: "playwright",
      action: {
        name: "locator",
        selector: a.selector,
        operation: a.operation,
        value: a.value,
        arg: a.arg,
        expression: a.expression,
        expressionKind: a.expressionKind,
        attribute: a.attribute,
        checked: a.checked,
        replace: a.replace,
        force: a.force,
        button: a.button,
        modifiers: a.modifiers,
        state: a.state,
        selections: a.selections,
        timeoutMs: a.timeoutMs,
      },
      tabId: a.tabId,
    }),
  );

  return server;
}

/**
 * /mcp 端点的 sessionful 分发：initialize 请求创建新 transport，
 * 之后按 mcp-session-id 头路由到对应 transport。
 * 注意 browser_tabs action=new 的 url 参数：由调用方在两步内 navigate（schema 不支持 url 字段）。
 */
/**
 * /mcp 端点的 sessionful 分发：initialize 请求创建新 transport + 新 McpServer
 * （SDK 1.30 的 Server 只允许一个 transport），之后按 mcp-session-id 头路由。
 */
export function createMcpHttpHandler(tabManager: TabManager) {
  const execute: Execute = (command, scope) => tabManager.execute(scope, command);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  /** sessionId → scope 上下文；会话关闭时用于判断分组是否还有其它存活会话在用。 */
  const sessionCtxs = new Map<string, SessionScopeCtx>();

  /**
   * session 存活判定：有挂起的 SSE 即活；挂过 SSE 的断开后给宽限期；
   * 从没挂过 SSE 的纯 POST 客户端按 idle TTL。死亡的 session 持有的分组
   * 变孤儿（tabManager.isScopeLive），可被其它 session 接管。
   */
  const isSessionLive = (o: SessionScopeCtx): boolean => {
    if (o.sseRes) return true;
    if (o.sseEverOpened) return Date.now() - (o.sseClosedAt ?? o.lastSeen) < ORPHAN_GRACE_MS;
    return Date.now() - o.lastSeen < IDLE_TTL_MS;
  };
  tabManager.isScopeLive = (key: string): boolean => {
    const sep = key.indexOf("\u0000");
    const client = key.slice(0, sep);
    const thread = key.slice(sep + 1);
    for (const o of sessionCtxs.values()) {
      if (o.client !== client) continue;
      const def = o.threadOverride ?? o.headerGroup ?? o.id;
      if (o.usedThreads.has(thread) || def === thread) {
        if (isSessionLive(o)) return true;
      }
    }
    return false;
  };

  const headerString = (req: http.IncomingMessage, name: string): string | undefined => {
    const value = req.headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === "string" && single.trim() ? single.trim() : undefined;
  };

  return async function handleMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
  ): Promise<void> {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32_000, message: "Bad Request: unknown or missing MCP session" },
            id: null,
          }),
        );
        return;
      }
      // 分组身份：client = x-bmcp-client 头 > clientInfo.name > "agent"（shim 会
      // 透传下游真实 client 名）；thread 默认 MCP session id，可用 x-bmcp-group 固定。
      const clientInfo = (body as { params?: { clientInfo?: { name?: string } } }).params
        ?.clientInfo;
      const ctx: SessionScopeCtx = {
        client:
          headerString(req, "x-bmcp-client") ??
          (typeof clientInfo?.name === "string" && clientInfo.name.trim()
            ? clientInfo.name.trim()
            : "agent"),
        headerGroup: headerString(req, "x-bmcp-group"),
        usedThreads: new Set(),
        lastSeen: Date.now(),
        sseEverOpened: false,
      };
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          ctx.id = id;
          transports.set(id, created);
          sessionCtxs.set(id, ctx);
        },
      });
      transport = created;
      created.onclose = () => {
        const sid = created.sessionId;
        if (sid) {
          transports.delete(sid);
          sessionCtxs.delete(sid);
        }
        // 会话结束（客户端 DELETE / transport close）：对齐 ZCode closeSession，
        // 把本 session 寻址过的分组的 tab 归还用户（页面保留）。若同名分组仍被
        // 其它存活 session 寻址（共享稳定分组名的场景），则跳过不释放。
        for (const thread of ctx.usedThreads) {
          const shared = [...sessionCtxs.values()].some((o) => {
            if (o.client !== ctx.client || !isSessionLive(o)) return false;
            const def = o.threadOverride ?? o.headerGroup ?? o.id;
            return o.usedThreads.has(thread) || def === thread;
          });
          if (shared) continue;
          const scope: AgentScope = {
            client: ctx.client,
            thread,
            ...(ctx.label ? { label: ctx.label } : {}),
          };
          execute({ method: "closeSession" }, scope)
            .then((r) => {
              if (r.ok) logger.info(`[mcp] session closed, released group ${ctx.client}/${thread}`);
              else logger.warn(`[mcp] closeSession failed for ${thread}:`, r.error);
            })
            .catch((e) => logger.warn(`[mcp] closeSession error for ${thread}:`, e));
        }
      };
      const server = createBrowserMcpServer(execute, ctx, tabManager);
      await server.connect(created);
    }
    // 存活信号维护：任何请求刷新 lastSeen；GET 请求是 standalone SSE 流，
    // 其 res 关闭即客户端断开（close() 只 abort SSE，不发 DELETE）。
    const sctx = sessionId ? sessionCtxs.get(sessionId) : undefined;
    if (sctx) {
      sctx.lastSeen = Date.now();
      if (req.method === "GET") {
        sctx.sseEverOpened = true;
        sctx.sseRes = res;
        res.on("close", () => {
          if (sctx.sseRes === res) {
            sctx.sseRes = undefined;
            sctx.sseClosedAt = Date.now();
          }
        });
      }
    }
    await transport.handleRequest(req, res, body);
  };
}
