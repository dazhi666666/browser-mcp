#!/usr/bin/env node
/**
 * browser-mcp skill CLI —— 零依赖的 MCP streamable-HTTP 客户端。
 *
 * 供 control-browser 技能（SKILL.md）驱动独立浏览器 App 用：自动读
 * ~/.browser-mcp/server.json 拿 {port, token}，不需要 browser-mcp 仓库的
 * node_modules，任何有 Node >= 18 的机器都能跑。
 *
 * 用法：
 *   node browser.mjs status                          # 发现信息 + 健康检查
 *   node browser.mjs tools                           # 工具清单（名字 + 一句话描述）
 *   node browser.mjs call <tool> [jsonArgs]          # 调用工具；文本结果打印 JSON
 *       [--group name]   覆盖本次调用的 tab 分组（thread 身份）
 *       [--out file.png] image content 落盘路径（缺省自动存临时目录并打印路径）
 *       [--timeout ms]   单次调用超时（缺省 60000）
 *
 * 环境变量（与 shim/index.mjs 语义一致）：
 *   BROWSER_MCP_HOME   覆盖 discovery 目录（默认 ~/.browser-mcp）
 *   BROWSER_MCP_GROUP  本机默认 tab 分组（--group 可按次覆盖）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const usage = () => {
  console.error("usage: browser.mjs status | tools | call <tool> [jsonArgs] [--group n] [--out f] [--timeout ms]");
  process.exit(2);
};
const args = process.argv.slice(2);
const cmd = args.shift();
if (!cmd || !["status", "tools", "call"].includes(cmd)) usage();

const parseFlag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const outPath = parseFlag("--out");
// 一次性 CLI 没有稳定的 MCP session id——不固定分组的话，每次调用都会拿到新身份、
// 在新分组里新建 tab（旧 tab 被释放成 user tab）。默认固定，跨调用才能复用同一 tab。
const group = parseFlag("--group") ?? process.env.BROWSER_MCP_GROUP ?? "cli";
const timeoutMs = Number(parseFlag("--timeout") ?? 60_000) || 60_000;

const home = process.env.BROWSER_MCP_HOME ?? join(homedir(), ".browser-mcp");
let discovery;
try {
  discovery = JSON.parse(readFileSync(join(home, "server.json"), "utf8"));
} catch {
  console.error(`browser-mcp: cannot read ${join(home, "server.json")} — the desktop app is not running (or never started).`);
  process.exit(1);
}
const base = `http://127.0.0.1:${discovery.port}`;

let nextId = 1;
let sessionId;
let failed = false;

async function rpc(method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${discovery.token}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
        ...(method.startsWith("notifications/") ? {} : { id: nextId }),
      }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    if (!text.trim()) return undefined; // notification 的 202 空响应
    const contentType = res.headers.get("content-type") ?? "";
    let message;
    if (contentType.includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const candidate = JSON.parse(line.slice(5).trim());
        if (candidate.id === nextId || candidate.error) message = candidate;
      }
    } else {
      message = JSON.parse(text);
    }
    if (!message) throw new Error(`no JSON-RPC response for id ${nextId}`);
    if (message.error) throw new Error(`${message.error.code}: ${message.error.message}`);
    nextId += 1;
    return message.result;
  } finally {
    clearTimeout(timer);
  }
}

const textOf = (r) =>
  (r?.content ?? [])
    .map((c) => (c.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join("\n");

async function init() {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-mcp-skill", version: "0.1.0" },
  });
  await rpc("notifications/initialized");
}

async function main() {
  if (cmd === "status") {
    let health = "unreachable";
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      health = res.ok ? "ok" : `HTTP ${res.status}`;
    } catch (e) {
      health = `unreachable (${e.cause?.code ?? e.message})`;
    }
    console.log(JSON.stringify({ ...discovery, token: "(hidden)", base, health }, null, 2));
    if (!health.startsWith("ok")) process.exitCode = 1;
    return;
  }
  await init();
  if (cmd === "tools") {
    const { tools } = await rpc("tools/list", {});
    for (const t of tools) {
      console.log(`- ${t.name}: ${String(t.description ?? "").split("\n")[0]}`);
    }
    return;
  }
  const tool = args.shift();
  if (!tool) usage();
  let toolArgs = {};
  if (args.length) {
    try {
      toolArgs = JSON.parse(args.shift());
    } catch (e) {
      console.error(`browser-mcp: jsonArgs is not valid JSON: ${e.message}`);
      process.exitCode = 2;
      return;
    }
  }
  if (group) toolArgs = { ...toolArgs, group };
  const result = await rpc("tools/call", { name: tool, arguments: toolArgs });
  const images = (result?.content ?? []).filter((c) => c.type === "image");
  for (const image of images) {
    const file =
      outPath ?? join(tmpdir(), `browser-mcp-${tool.replace(/\W+/g, "-")}-${Date.now()}.png`);
    mkdirSync(String(file).split(/[\\/]/).slice(0, -1).join("/") || ".", { recursive: true });
    writeFileSync(file, Buffer.from(image.data, "base64"));
    console.log(`[image saved: ${file}] (${image.mimeType})`);
  }
  const text = textOf(result);
  if (text) console.log(text);
  if (result?.isError) failed = true;
}

try {
  await main();
} catch (e) {
  console.error(`browser-mcp: ${e.message}`);
  process.exitCode = 1;
}
// 不用 process.exit()：Windows 上与还在关闭的 UV 句柄竞态会打 libuv 断言、污染退出码。
if (failed) process.exitCode = process.exitCode || 1;
