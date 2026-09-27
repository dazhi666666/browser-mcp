import { randomUUID } from "node:crypto";
import electron from "electron";
import type {
  BrowserWindow,
  HandlerDetails,
  Referrer,
  WebContents,
  WebContentsView as WebContentsViewType,
} from "electron";
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserDialog,
} from "../shared/index.js";
import { executeBrowserCommandOnView } from "./browser/browserCommandExecutor.js";
import type { ControlledView } from "./browser/browserCommandTypes.js";
import type { HistoryStore, BookmarkStore } from "./userData.js";
import { logger } from "./logger.js";

const { WebContentsView } = electron;

/** chrome 顶部默认高度：tab 条 40 + 导航栏 48；收藏夹栏显示时由 renderer 上报更新。 */
export const TOOLBAR_HEIGHT = 88;
const SESSION_PARTITION = "persist:browser-mcp";
const DEBUGGER_PROTOCOL = "1.3";
const WAIT_FOR_POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 5_000;
const DIALOG_AUTO_DISMISS_MS = 60_000;

/**
 * Agent 身份作用域：client = agent 软件（MCP clientInfo.name / x-bmcp-client），
 * thread = 对话线程（MCP session id / BROWSER_MCP_GROUP / browser_scope 设置）。
 * 同一 scope 的 tab 归入同一个 Edge 式 tab group；不同 scope 互相不可见、不可寻址。
 * UI 手工创建的 tab groupId 为空（user tab），agent 首次显式寻址时隐式 claim 进组。
 */
export interface AgentScope {
  client: string;
  thread: string;
  /** 分组展示名（browser_scope set name / nameSession）。 */
  label?: string;
}

export interface TabGroupInfo {
  id: string;
  label: string;
  color: string;
}

export interface TabSummary {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
  favicon?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  group?: TabGroupInfo;
}

interface ManagedTab {
  tabId: string;
  view: WebContentsViewType;
  controlled: ControlledView;
  /** page-favicon-updated 记录的最新 favicon URL（renderer tab 条展示用）。 */
  favicon?: string;
  isLoading: boolean;
  /** CDP Emulation.setDeviceMetricsOverride 生效中的 CSS viewport override。 */
  viewportOverride?: { width: number; height: number };
  /** 归属的 agent 分组；undefined = 用户手开的 tab（可被任一 scope claim）。 */
  groupId?: string;
}

/** Edge tab group 风格的配色循环。 */
const GROUP_COLORS = [
  "#5b9bd5",
  "#a170c9",
  "#e58fb5",
  "#e06666",
  "#ed9a4e",
  "#e8c445",
  "#78b465",
  "#55b3a5",
];

function scopeKey(scope: AgentScope): string {
  return `${scope.client}\u0000${scope.thread}`;
}

/**
 * main 进程直接持有 WebContentsView 的 tab 管理器。
 * 替代 ZCode 的 browserGuestManager：webview 不再由 renderer 创建，
 * 因此 attach/rebind/React key 替换那套生命周期不存在；只保留崩溃重建。
 *
 * 命令分两层：
 * - manager 级（tab 生命周期 / dialog / viewport / visibility / 等待 / 会话元命令）在这里处理；
 * - 页面级命令转发给 executeBrowserCommandOnView（ZCode executor 层原样移植）。
 */
export class TabManager {
  private tabs = new Map<string, ManagedTab>();
  private activeTabId: string | undefined;
  private executing = 0;
  private visible = true;
  private pendingDialogs = new Map<string, BrowserDialog>();
  private dialogDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** chrome 实际占位：顶部高度（收藏夹栏显隐会变化）与右侧停靠面板宽度。 */
  private chromeTop = TOOLBAR_HEIGHT;
  private chromeRight = 0;
  /** agent 分组注册表：groupId → 展示信息；颜色按注册顺序循环分配。 */
  private groups = new Map<string, TabGroupInfo>();
  /** 每个 scope 最近使用的 tab（无显式 tabId 的命令落点，对应 ZCode 的 active/defaultTabByScope）。 */
  private lastTabByScope = new Map<string, string>();

  constructor(
    private win: BrowserWindow,
    private onChanged: () => void,
    private onBusy: (busy: boolean) => void,
    private windowCtl?: { parkWindow: () => void; unparkWindow: () => void },
    private history?: HistoryStore,
    private bookmarks?: BookmarkStore,
  ) {
    win.on("resize", () => this.layoutActive());
  }

  /** renderer 上报 chrome 实际布局：收藏夹栏显隐改变 top，侧面板开合改变 right。 */
  setChromeLayout(layout: { top?: number; right?: number }): void {
    this.chromeTop = Math.max(0, layout.top ?? TOOLBAR_HEIGHT);
    this.chromeRight = Math.max(0, layout.right ?? 0);
    this.layoutActive();
  }

  list(): TabSummary[] {
    return [...this.tabs.values()].map((t) => ({
      tabId: t.tabId,
      url: safe(() => t.view.webContents.getURL(), ""),
      title: safe(() => t.view.webContents.getTitle(), ""),
      favicon: t.favicon,
      isLoading: t.isLoading,
      canGoBack: safe(() => t.view.webContents.navigationHistory.canGoBack(), false),
      canGoForward: safe(() => t.view.webContents.navigationHistory.canGoForward(), false),
      active: t.tabId === this.activeTabId,
      ...(t.groupId && this.groups.has(t.groupId)
        ? { group: { ...this.groups.get(t.groupId)! } }
        : {}),
    }));
  }

  getActiveTabId(): string | undefined {
    return this.activeTabId;
  }

  newTab(url?: string): string {
    const tab = this.createTabBase(url);
    this.activate(tab.tabId);
    this.onChanged();
    return tab.tabId;
  }

  private createTabBase(url?: string, referrer?: Referrer): ManagedTab {
    const tabId = randomUUID();
    const tab: ManagedTab = {
      tabId,
      view: this.createView(),
      controlled: undefined as unknown as ControlledView,
      isLoading: false,
    };
    tab.controlled = this.buildControlledView(tab);
    this.tabs.set(tabId, tab);
    // 无 url 也显式加载 about:blank：确保提交 document（dom-ready 才会触发
    // 新标签页磁贴注入，evaluate 等命令也才有可执行上下文）。
    void tab.view.webContents
      .loadURL(
        url ? normalizeUrl(url) : "about:blank",
        referrer ? { httpReferrer: referrer } : undefined,
      )
      .catch((e) => logger.warn(`initial loadURL failed: ${e}`));
    return tab;
  }

  // ---------------------------------------------------------------- groups

  private groupFor(scope: AgentScope): TabGroupInfo {
    const id = scopeKey(scope);
    let group = this.groups.get(id);
    if (!group) {
      group = {
        id,
        label: scope.label ?? `${scope.client}·${scope.thread.slice(0, 8)}`,
        color: GROUP_COLORS[this.groups.size % GROUP_COLORS.length],
      };
      this.groups.set(id, group);
      this.onChanged();
    } else if (scope.label && group.label !== scope.label) {
      group.label = scope.label;
      this.onChanged();
    }
    return group;
  }

  /** 把 tab 挪到指定 tab 之后（目标不存在则保持末尾）。 */
  private moveAfter(tab: ManagedTab, afterTabId: string): void {
    const entries = [...this.tabs.entries()].filter(([id]) => id !== tab.tabId);
    const idx = entries.findIndex(([id]) => id === afterTabId);
    entries.splice(idx >= 0 ? idx + 1 : entries.length, 0, [tab.tabId, tab]);
    this.tabs = new Map(entries);
  }

  /**
   * 页面请求开新窗口（target=_blank / window.open）时改建同窗口 tab。
   * 新 tab 继承来源 tab 的分组：agent 页弹出的页面仍归该 agent 线程可见可控；
   * user tab 的 popup 保持 user tab 并紧邻 opener 排列。
   */
  private openPopupTab(source: ManagedTab | undefined, details: HandlerDetails): void {
    if (!isAllowedPopupUrl(details.url)) {
      logger.warn(`blocked popup url: ${details.url}`);
      return;
    }
    const tab = this.createTabBase(details.url, details.referrer);
    if (source?.groupId) {
      tab.groupId = source.groupId;
      this.moveAfterGroupMates(tab);
      // popup 是该 scope 最新拥有的 tab：agent 点击链接后的下一条命令应落在它上面
      // （对齐 ZCode：popup 继承 owner，resolveTab 按最近 tab 命中）。
      this.lastTabByScope.set(tab.groupId, tab.tabId);
    } else if (source) {
      this.moveAfter(tab, source.tabId);
    }
    // background-tab（Ctrl/中键点击）只建不激活；其余 disposition 前台打开。
    if (details.disposition === "background-tab") {
      this.onChanged();
    } else {
      this.activate(tab.tabId);
    }
  }

  /** 把 tab 挪到同组最后一个成员之后，保证分组在 tab 条上连续。 */
  private moveAfterGroupMates(tab: ManagedTab): void {
    if (!tab.groupId) return;
    const entries = [...this.tabs.entries()].filter(([id]) => id !== tab.tabId);
    let lastMate = -1;
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i][1].groupId === tab.groupId) lastMate = i;
    }
    entries.splice(lastMate + 1, 0, [tab.tabId, tab]);
    this.tabs = new Map(entries);
  }

  /** user tab 被 agent 首次寻址 → 隐式 claim 进该 scope 的分组。 */
  private claimIntoGroup(tab: ManagedTab, scope: AgentScope): void {
    const group = this.groupFor(scope);
    tab.groupId = group.id;
    this.lastTabByScope.set(group.id, tab.tabId);
    this.moveAfterGroupMates(tab);
    logger.debug(`[browser-mcp] claimed tab ${tab.tabId} into group "${group.label}"`);
    this.onChanged();
  }

  /** 释放回 user tab（对应 ZCode 的 releaseToUser：页面保留，脱离分组）。 */
  private releaseFromGroup(tab: ManagedTab): void {
    if (!tab.groupId) return;
    if (this.lastTabByScope.get(tab.groupId) === tab.tabId) {
      this.lastTabByScope.delete(tab.groupId);
    }
    tab.groupId = undefined;
    this.onChanged();
  }

  /**
   * scope 内寻址（ZCode resolveTab 的独立版）：
   * 显式 tabId → 同组直接用；user tab 隐式 claim；其它组的 tab 对本 scope 不可见。
   * 无 tabId → scope 最近 tab → 组内最新 tab → create 时自动新建入组 tab。
   */
  private resolveTab(
    scope: AgentScope,
    explicitTabId?: string,
    create = false,
  ): ManagedTab | undefined {
    const gid = this.groupFor(scope).id;
    if (explicitTabId) {
      const tab = this.tabs.get(explicitTabId);
      if (!tab) return undefined;
      if (tab.groupId === gid) {
        this.lastTabByScope.set(gid, tab.tabId);
        return tab;
      }
      if (tab.groupId === undefined) {
        this.claimIntoGroup(tab, scope);
        return tab;
      }
      return undefined;
    }
    const lastId = this.lastTabByScope.get(gid);
    const last = lastId ? this.tabs.get(lastId) : undefined;
    if (last && last.groupId === gid) return last;
    const owned = [...this.tabs.values()].filter((t) => t.groupId === gid);
    if (owned.length > 0) {
      const tab = owned[owned.length - 1];
      this.lastTabByScope.set(gid, tab.tabId);
      return tab;
    }
    if (!create) return undefined;
    const tab = this.createTabBase();
    tab.groupId = gid;
    this.moveAfterGroupMates(tab);
    this.lastTabByScope.set(gid, tab.tabId);
    this.activate(tab.tabId);
    this.onChanged();
    return tab;
  }

  /** browser_scope get / 会话默认 scope 的展示信息。 */
  scopeInfo(scope: AgentScope): TabGroupInfo & { client: string; thread: string; tabCount: number } {
    const group = this.groupFor(scope);
    return {
      ...group,
      client: scope.client,
      thread: scope.thread,
      tabCount: [...this.tabs.values()].filter((t) => t.groupId === group.id).length,
    };
  }

  /** browser_scope set：改线程标识时把本 scope 已有 tab 迁移到新分组。 */
  renameScope(from: AgentScope, to: AgentScope): void {
    const fromKey = scopeKey(from);
    if (fromKey === scopeKey(to)) {
      if (to.label) this.groupFor(to);
      return;
    }
    const toGroup = this.groupFor(to);
    const lastId = this.lastTabByScope.get(fromKey);
    for (const tab of this.tabs.values()) {
      if (tab.groupId === fromKey) {
        tab.groupId = toGroup.id;
        this.moveAfterGroupMates(tab);
      }
    }
    this.lastTabByScope.delete(fromKey);
    if (lastId) this.lastTabByScope.set(toGroup.id, lastId);
    this.groups.delete(fromKey);
    this.onChanged();
  }

  activate(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (this.activeTabId && this.activeTabId !== tabId) {
      const prev = this.tabs.get(this.activeTabId);
      if (prev) this.win.contentView.removeChildView(prev.view);
    }
    this.activeTabId = tabId;
    this.win.contentView.addChildView(tab.view);
    this.layoutActive();
    tab.view.webContents.focus();
    this.onChanged();
    return true;
  }

  close(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (this.activeTabId === tabId) {
      this.win.contentView.removeChildView(tab.view);
      this.activeTabId = undefined;
    }
    this.tabs.delete(tabId);
    this.clearDialogState(tabId);
    tab.view.webContents.close();
    const next = this.tabs.keys().next().value;
    if (next && !this.activeTabId) this.activate(next);
    this.onChanged();
    return true;
  }

  navigateActive(url: string): void {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (!tab) return;
    void tab.view.webContents.loadURL(normalizeUrl(url)).catch((e) => logger.warn(`${e}`));
  }

  goBack(): void {
    const tab = this.activeTab();
    if (tab?.view.webContents.navigationHistory.canGoBack()) {
      tab.view.webContents.goBack();
    }
  }

  goForward(): void {
    const tab = this.activeTab();
    if (tab?.view.webContents.navigationHistory.canGoForward()) {
      tab.view.webContents.goForward();
    }
  }

  reloadActive(): void {
    this.activeTab()?.view.webContents.reload();
  }

  openDevTools(): void {
    this.activeTab()?.view.webContents.openDevTools({ mode: "detach" });
  }

  private activeTab(): ManagedTab | undefined {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
  }

  private findByWebContents(wc: WebContents): ManagedTab | undefined {
    return [...this.tabs.values()].find((t) => t.view.webContents === wc);
  }

  // ---------------------------------------------------------------- command dispatch

  async execute(scope: AgentScope, command: BrowserCommand): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    const finish = (
      partial: Omit<BrowserCommandResult, "elapsedMs">,
    ): BrowserCommandResult => ({ ...partial, elapsedMs: Date.now() - startedAt });
    const fail = (code: string, message: string): BrowserCommandResult =>
      finish({
        ok: false,
        error: { code: code as never, message },
      });
    const scopedTabSummary = (tab: ManagedTab) => this.summaryOf(tab.tabId);
    const resolve = (explicit?: string, create = false) =>
      this.resolveTab(scope, explicit, create);
    // 显式 tabId 但属于其它 agent 分组 → 对本 scope 不可见，按不存在处理。
    const explicitTabId = "tabId" in command ? (command.tabId ?? undefined) : undefined;
    const wrongGroup = (tab: ManagedTab | undefined) =>
      explicitTabId !== undefined && tab === undefined && this.tabs.has(explicitTabId)
        ? fail("backend_unavailable", `browser tab '${explicitTabId}' belongs to another group`)
        : undefined;

    // minimized 窗口的页面被标 hidden，CDP Input 会被静默丢弃。用户点最小化
    // 已在 main.ts 被拦截改成屏幕外停靠（不弹窗），这里只兜底非常规路径
    // （如外部工具直接最小化）。
    if (this.win.isMinimized()) {
      this.win.restore();
    }

    // ---- manager 级命令：不要求已 attach 的页面 ----
    switch (command.method) {
      case "list":
        // 本组受控 tab + 可被 claim 的 user tab；其它组的 tab 对 agent 不可见。
        return finish({
          ok: true,
          tabs: [...this.tabs.values()]
            .filter((t) => t.groupId === scopeKey(scope))
            .map(scopedTabSummary),
          userTabs: this.userTabInfos(),
        });
      case "listUserTabs":
        return finish({ ok: true, userTabs: this.userTabInfos() });
      case "newTab": {
        // newTab 永远新建（不能走 resolveTab 的复用路径），直接入组并激活。
        const gid = this.groupFor(scope).id;
        const tab = this.createTabBase();
        tab.groupId = gid;
        this.moveAfterGroupMates(tab);
        this.lastTabByScope.set(gid, tab.tabId);
        this.activate(tab.tabId);
        this.onChanged();
        return finish({ ok: true, tab: scopedTabSummary(tab) });
      }
      case "activateTab": {
        const tab = resolve(command.tabId);
        if (!tab) return wrongGroup(undefined) ?? fail("execution_error", `no such tab: ${command.tabId}`);
        this.activate(tab.tabId);
        return finish({ ok: true, tab: scopedTabSummary(tab) });
      }
      case "claimTab": {
        const tab = resolve(command.tabId);
        if (!tab) {
          return (
            wrongGroup(undefined) ??
            fail("execution_error", `user browser tab '${command.tabId}' is unavailable`)
          );
        }
        this.activate(tab.tabId);
        return finish({ ok: true, tab: scopedTabSummary(tab) });
      }
      case "close": {
        const tab = resolve(explicitTabId);
        if (!tab) {
          return wrongGroup(undefined) ?? fail("execution_error", "no such tab");
        }
        this.close(tab.tabId);
        return finish({ ok: true });
      }
      case "browserVisibilityGet":
        return finish({ ok: true, value: this.visible });
      case "browserVisibilitySet": {
        this.visible = command.visible;
        if (command.visible) {
          this.windowCtl?.unparkWindow();
          this.win.show();
          this.win.focus();
        } else if (this.windowCtl) {
          // 停靠而非 hide()：保持页面可见态与输入派发。停靠位置必须留 2px
          // 在屏内（见 main.ts parkWindow），完全离屏会丢合成表面。
          this.windowCtl.parkWindow();
        } else {
          this.win.hide();
        }
        return finish({ ok: true });
      }
      case "capabilities":
        return finish({
          ok: true,
          value: {
            backend: "electron-webcontentsview",
            dialogs: true,
            viewportOverride: true,
            recording: false,
            visibility: true,
          },
        });
      case "playwrightWaitForTimeout": {
        await sleep(command.timeoutMs);
        return finish({ ok: true });
      }
      case "waitFor": {
        const tab = resolve(explicitTabId);
        if (!tab) return wrongGroup(tab) ?? fail("execution_error", "no such tab");
        return this.waitFor(tab, command, finish);
      }
      case "fill": {
        const tab = resolve(explicitTabId);
        if (!tab) return wrongGroup(tab) ?? fail("execution_error", "no such tab");
        return this.fill(tab, command.ref, command.value, finish);
      }
      case "getDialog": {
        const tab = resolve(explicitTabId);
        if (!tab) return finish({ ok: true, dialog: null });
        return finish({ ok: true, dialog: this.pendingDialogs.get(tab.tabId) ?? null });
      }
      case "handleDialog": {
        const tab = resolve(explicitTabId);
        if (!tab) return wrongGroup(tab) ?? fail("execution_error", "no such tab");
        if (!this.pendingDialogs.has(tab.tabId)) {
          return fail("execution_error", "no pending JavaScript dialog for this tab");
        }
        await tab.view.webContents.debugger
          .sendCommand("Page.handleJavaScriptDialog", {
            accept: command.accept,
            ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
          })
          .catch((error) => logger.warn(`handleJavaScriptDialog failed: ${error}`));
        this.clearDialogState(tab.tabId);
        return finish({ ok: true });
      }
      case "browserViewportSet": {
        const tab = resolve(explicitTabId);
        if (!tab) return wrongGroup(tab) ?? fail("execution_error", "no such tab");
        tab.viewportOverride = { width: command.width, height: command.height };
        await tab.view.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: command.width,
          height: command.height,
          // 可见 surface 仍由 view bounds 管理；CDP 只负责 CSS viewport。
          deviceScaleFactor: 1,
          mobile: false,
          dontSetVisibleSize: true,
        });
        return finish({ ok: true });
      }
      case "browserViewportReset": {
        const tab = resolve(explicitTabId);
        if (!tab) return wrongGroup(tab) ?? fail("execution_error", "no such tab");
        tab.viewportOverride = undefined;
        await tab.view.webContents.debugger
          .sendCommand("Emulation.clearDeviceMetricsOverride")
          .catch(() => undefined);
        return finish({ ok: true });
      }
      // ---- 会话/生命周期元命令 ----
      case "nameSession":
        // ZCode 用 nameSession 给会话起名；独立版直接作用于分组标签。
        this.groupFor({ ...scope, label: command.name });
        return finish({ ok: true });
      case "markDeliverable": {
        // 交付给用户：tab 脱离分组变回 user tab（页面保留）。
        const tab = resolve(command.tabId);
        if (!tab) return wrongGroup(tab) ?? fail("execution_error", "no such tab");
        this.releaseFromGroup(tab);
        return finish({ ok: true });
      }
      case "markHandoff":
        // handoff 语义在独立版等价于保留在组内；不额外标记。
        return finish({ ok: true });
      case "finalize":
      case "finalizeTabs": {
        // finalize：deliverable 标记的（或 finalize 全部）tab 归还用户。
        if (command.method === "finalize") {
          const tab = resolve(command.tabId);
          if (tab) this.releaseFromGroup(tab);
          return finish({ ok: true });
        }
        const keep = new Map(command.keep.map((k) => [k.tabId, k.status]));
        for (const tab of this.tabs.values()) {
          if (tab.groupId !== scopeKey(scope)) continue;
          if (keep.get(tab.tabId) === "deliverable") this.releaseFromGroup(tab);
        }
        return finish({ ok: true });
      }
      case "closeSession": {
        // 会话结束：本组 tab 全部归还为用户 tab（页面保留，分组解散）。
        for (const tab of this.tabs.values()) {
          if (tab.groupId === scopeKey(scope)) this.releaseFromGroup(tab);
        }
        this.lastTabByScope.delete(scopeKey(scope));
        return finish({ ok: true });
      }
      case "turnEnded":
      case "cancelRequest":
        return finish({ ok: true });
      case "recordingStart":
      case "recordingStatus":
      case "recordingCancel":
        return fail("capability_unsupported", "recording is not implemented yet");
      default:
        break;
    }

    // ---- 页面级命令：交给移植的 executor 层 ----
    // 无 tabId 且无现存 tab 时自动建组内 tab（对应 ZCode resolveTab 的隐式创建），
    // agent 的第一条 navigate 即可直接落页。
    const tab = resolve(explicitTabId, true);
    if (!tab) return wrongGroup(tab) ?? fail("execution_error", "no such tab (open one first)");
    this.executing += 1;
    if (this.executing === 1) this.onBusy(true);
    try {
      return await executeBrowserCommandOnView(tab.controlled, command);
    } finally {
      this.executing -= 1;
      if (this.executing === 0) this.onBusy(false);
    }
  }

  // ---------------------------------------------------------------- internals

  private createView(): WebContentsViewType {
    const view = new WebContentsView({
      webPreferences: {
        partition: SESSION_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const wc = view.webContents;
    this.attachDebugger(wc);

    const tabIdHolder = { tabId: "" };
    const refresh = () => this.onChanged();
    const recordVisit = (url: string) => {
      this.history?.visit({ url, title: safe(() => wc.getTitle(), "") });
    };
    wc.on("did-navigate", (_e, url) => {
      const entry = this.findByWebContents(wc);
      if (entry) entry.favicon = undefined;
      recordVisit(url);
      refresh();
    });
    // 新标签页：about:blank 的 DOM 由 main 注入收藏夹磁贴（Edge NTP 风格）。
    // dom-ready 对初始 about:blank 与显式导航都触发。
    wc.on("dom-ready", () => {
      if (safe(() => wc.getURL(), "") === "about:blank") this.renderNewTabPage(wc);
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame !== false) recordVisit(url);
      refresh();
    });
    wc.on("page-title-updated", (_e, title) => {
      this.history?.updateTitle(safe(() => wc.getURL(), ""), title);
      refresh();
    });
    wc.on("page-favicon-updated", (_e, favicons) => {
      // 无 favicon 的站点 Chromium 会上报占位 "data:,"，按无图标处理。
      const icon = favicons.find((f) => f && f !== "data:,");
      const entry = this.findByWebContents(wc);
      if (entry && icon) {
        entry.favicon = icon;
        this.history?.updateFavicon(safe(() => wc.getURL(), ""), icon);
        this.onChanged();
      }
    });
    wc.on("did-start-loading", () => {
      const entry = this.findByWebContents(wc);
      if (entry && !entry.isLoading) {
        entry.isLoading = true;
        this.onChanged();
      }
    });
    wc.on("did-stop-loading", () => {
      const entry = this.findByWebContents(wc);
      if (entry?.isLoading) {
        entry.isLoading = false;
        this.onChanged();
      }
    });
    // 页面请求新窗口：deny Electron 默认的裸 BrowserWindow，改建本窗口 tab
    // （对齐 ZCode desktopWindowChrome 的 deny+路由模型）。popup 的 URL 可能带
    // javascript:/data: 等非网页协议，必须过滤，否则等于给页面开了任意导航口。
    wc.setWindowOpenHandler((details) => {
      this.openPopupTab(this.findByWebContents(wc), details);
      return { action: "deny" };
    });
    wc.on("render-process-gone", (_e, details) => {
      logger.warn(`tab render process gone reason=${details.reason}`);
      const entry = this.findByWebContents(wc);
      if (entry) this.recoverTab(entry);
    });
    wc.on("destroyed", () => {
      const entry = this.findByWebContents(wc);
      if (entry) {
        this.tabs.delete(entry.tabId);
        if (this.activeTabId === entry.tabId) this.activeTabId = undefined;
        this.onChanged();
      }
    });
    wc.debugger.on("message", (_event, method, params) => {
      const entry = this.findByWebContents(wc);
      const tabId = entry?.tabId ?? tabIdHolder.tabId;
      if (method === "Page.javascriptDialogOpening" && tabId) {
        const data = (params ?? {}) as {
          type?: string;
          message?: string;
          defaultPrompt?: string;
        };
        this.pendingDialogs.set(tabId, {
          type: normalizeDialogType(data.type),
          message: typeof data.message === "string" ? data.message : "",
          ...(typeof data.defaultPrompt === "string"
            ? { defaultPrompt: data.defaultPrompt }
            : {}),
        });
        // 没有 agent 处理时不能无限挂起页面：超时自动 dismiss。
        const timer = setTimeout(() => {
          if (this.pendingDialogs.has(tabId)) {
            logger.warn(`auto-dismissing stale JS dialog tabId=${tabId}`);
            void wc.debugger
              .sendCommand("Page.handleJavaScriptDialog", { accept: false })
              .catch(() => undefined);
            this.clearDialogState(tabId);
          }
        }, DIALOG_AUTO_DISMISS_MS);
        this.dialogDismissTimers.set(tabId, timer);
      } else if (method === "Page.javascriptDialogClosed" && tabId) {
        this.clearDialogState(tabId);
      }
    });
    return view;
  }

  private clearDialogState(tabId: string): void {
    this.pendingDialogs.delete(tabId);
    const timer = this.dialogDismissTimers.get(tabId);
    if (timer) clearTimeout(timer);
    this.dialogDismissTimers.delete(tabId);
  }

  /** 可被任意 scope claim 的 user tab（UI 手开的页面）；对应 ZCode 的 listUserTabs。 */
  private userTabInfos() {
    return [...this.tabs.values()]
      .filter((t) => t.groupId === undefined)
      .map((t) => ({
        id: t.tabId,
        url: safe(() => t.view.webContents.getURL(), ""),
        title: safe(() => t.view.webContents.getTitle(), ""),
        active: t.tabId === this.activeTabId,
      }));
  }

  private summaryOf(tabId: string) {
    const tab = this.tabs.get(tabId);
    return {
      tabId,
      url: safe(() => tab?.view.webContents.getURL() ?? "", ""),
      title: safe(() => tab?.view.webContents.getTitle() ?? "", ""),
      viewport: this.viewportOf(tabId),
      active: tabId === this.activeTabId,
    };
  }

  private viewportOf(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return { width: 0, height: 0 };
    if (tab.viewportOverride) return tab.viewportOverride;
    const bounds = tab.view.getBounds();
    return { width: bounds.width, height: bounds.height };
  }

  /** waitFor：轮询 evaluate 直到 selector/text 命中或超时。 */
  private async waitFor(
    tab: ManagedTab,
    command: Extract<BrowserCommand, { method: "waitFor" }>,
    finish: (p: Omit<BrowserCommandResult, "elapsedMs">) => BrowserCommandResult,
  ): Promise<BrowserCommandResult> {
    const timeout = command.timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    const checkExpression = buildWaitForExpression(command);
    for (;;) {
      const hit = (await tab.view.webContents
        .executeJavaScript(checkExpression, true)
        .catch(() => false)) as boolean;
      if (hit) return finish({ ok: true, state: this.readTabState(tab) });
      if (Date.now() >= deadline) {
        return finish({
          ok: false,
          error: { code: "timeout" as never, message: `waitFor timed out after ${timeout}ms` },
        });
      }
      await sleep(WAIT_FOR_POLL_INTERVAL_MS);
    }
  }

  /** fill：把 ref 解析为元素后走原生 setter + input/change 事件（Playwright fill 语义的最小实现）。 */
  private async fill(
    tab: ManagedTab,
    ref: string,
    value: string,
    finish: (p: Omit<BrowserCommandResult, "elapsedMs">) => BrowserCommandResult,
  ): Promise<BrowserCommandResult> {
    const result = (await tab.view.webContents
      .executeJavaScript(FILL_SCRIPT(ref, value), true)
      .catch((error) => ({ ok: false, message: String(error) }))) as
      | { ok: boolean; message?: string }
      | null;
    if (!result?.ok) {
      return finish({
        ok: false,
        error: {
          code: "ref_not_found" as never,
          message: result?.message ?? `ref ${ref} not found or not fillable`,
        },
      });
    }
    return finish({ ok: true, state: this.readTabState(tab) });
  }

  private readTabState(tab: ManagedTab) {
    const wc = tab.view.webContents;
    return {
      url: safe(() => wc.getURL(), ""),
      title: safe(() => wc.getTitle(), ""),
      canGoBack: safe(() => wc.navigationHistory.canGoBack(), false),
      canGoForward: safe(() => wc.navigationHistory.canGoForward(), false),
    };
  }

  private buildControlledView(tab: ManagedTab): ControlledView {
    const wc = tab.view.webContents;
    return {
      webContents: {
        loadURL: (url) => wc.loadURL(url),
        getURL: () => wc.getURL(),
        getTitle: () => wc.getTitle(),
        canGoBack: () => wc.navigationHistory.canGoBack(),
        canGoForward: () => wc.navigationHistory.canGoForward(),
        goBack: () => wc.goBack(),
        goForward: () => wc.goForward(),
        reload: () => wc.reload(),
        executeJavaScript: (script) => wc.executeJavaScript(script, true),
      },
      cdp: {
        send: (method, params, sessionId) => {
          this.attachDebugger(wc);
          return wc.debugger.sendCommand(method, params as object | undefined, sessionId);
        },
      },
      captureViewportScreenshot: async () => {
        // 视图无合成表面时 capturePage 可能永不 resolve（曾观察到挂起 >70s），
        // 超时兜底让命令快速失败而不是把请求挂死。
        const image = await Promise.race([
          wc.capturePage(),
          new Promise<Electron.NativeImage>((_, reject) =>
            setTimeout(() => reject(new Error("capturePage timed out")), 10_000),
          ),
        ]);
        return image.isEmpty() ? undefined : image.toPNG().toString("base64");
      },
    };
  }

  /** 在 about:blank 上注入新标签页：收藏夹磁贴网格。 */
  private renderNewTabPage(wc: WebContents): void {
    const items = (this.bookmarks?.list() ?? []).slice(0, 12);
    void wc
      .executeJavaScript(NEW_TAB_SCRIPT(JSON.stringify(items)), true)
      .catch((e) => logger.warn(`new tab page inject failed: ${e}`));
  }

  private attachDebugger(wc: WebContents): void {
    if (wc.isDestroyed() || wc.debugger.isAttached()) return;
    try {
      wc.debugger.attach(DEBUGGER_PROTOCOL);
      // 裸 attach 得到的是干净 session：Page.enable 缺失会让 JS dialog 事件黑洞、
      // evaluate 遇到 dialog 挂起。必须补发（参照 ZCode guestManager 的恢复契约）。
      void wc.debugger.sendCommand("Page.enable").catch((error) => {
        logger.warn(`Page.enable failed: ${error}`);
      });
    } catch (error) {
      logger.warn(`debugger attach failed: ${error}`);
    }
  }

  private recoverTab(tab: ManagedTab): void {
    const url = safe(() => tab.view.webContents.getURL(), "");
    if (tab.view.webContents.isDestroyed()) {
      const replacement = this.createView();
      const wasActive = this.activeTabId === tab.tabId;
      if (wasActive) this.win.contentView.removeChildView(tab.view);
      tab.view = replacement;
      tab.controlled = this.buildControlledView(tab);
      if (wasActive) {
        this.win.contentView.addChildView(replacement);
        this.layoutActive();
      }
      if (url && url !== "about:blank") {
        void replacement.webContents.loadURL(url).catch(() => undefined);
      }
    } else {
      tab.view.webContents.reload();
    }
    this.onChanged();
  }

  private layoutActive(): void {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    const [width, height] = this.win.getContentSize();
    tab.view.setBounds({
      x: 0,
      y: this.chromeTop,
      width: Math.max(0, width - this.chromeRight),
      height: Math.max(0, height - this.chromeTop),
    });
  }
}

/** popup 允许落成 tab 的协议（about: 覆盖 window.open() 无参场景）。 */
const POPUP_ALLOWED_PROTOCOLS = new Set(["http:", "https:", "about:"]);

function isAllowedPopupUrl(url: string): boolean {
  try {
    return POPUP_ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function normalizeDialogType(type?: string): BrowserDialog["type"] {
  return type === "confirm" || type === "prompt" || type === "beforeunload" ? type : "alert";
}

function buildWaitForExpression(
  command: Extract<BrowserCommand, { method: "waitFor" }>,
): string {
  const parts: string[] = [];
  if (command.selector) {
    parts.push(`!!document.querySelector(${JSON.stringify(command.selector)})`);
  }
  if (command.text) {
    parts.push(
      `(document.body&&document.body.innerText||'').includes(${JSON.stringify(command.text)})`,
    );
  }
  if (command.textGone) {
    parts.push(
      `!(document.body&&document.body.innerText||'').includes(${JSON.stringify(command.textGone)})`,
    );
  }
  if (parts.length === 0) return "true";
  return `(${parts.join("&&")})`;
}

/**
 * fill 页面脚本：ref → __zcodeRefs 元素 → focus + 原生 setter + input/change 事件。
 * input/textarea 走 valueSetter；select 按值匹配 option；contenteditable 写 textContent。
 */
function FILL_SCRIPT(ref: string, value: string): string {
  const refLit = JSON.stringify(ref);
  const valueLit = JSON.stringify(value);
  return (
    "(function(){" +
    "var m=window.__zcodeRefs;var el=m&&m.get(" +
    refLit +
    ");" +
    "if(!el)return {ok:false,message:'ref not found: '+" +
    refLit +
    "};" +
    "var tag=el.tagName?el.tagName.toLowerCase():'';" +
    "try{el.scrollIntoView({block:'center'});el.focus();}catch(e){}" +
    "if(tag==='input'||tag==='textarea'){" +
    "var proto=tag==='textarea'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;" +
    "var desc=Object.getOwnPropertyDescriptor(proto,'value');" +
    "if(desc&&desc.set)desc.set.call(el," +
    valueLit +
    ");else el.value=" +
    valueLit +
    ";" +
    "el.dispatchEvent(new Event('input',{bubbles:true}));" +
    "el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true};}" +
    "if(tag==='select'){" +
    "var v=" +
    valueLit +
    ";var hit=false;for(var i=0;i<el.options.length;i++){var o=el.options[i];var match=o.value===v||o.text===v;if(match)hit=true;o.selected=match;}" +
    "if(!hit)return {ok:false,message:'no matching option'};" +
    "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true};}" +
    "if(el.isContentEditable){el.textContent=" +
    valueLit +
    ";el.dispatchEvent(new Event('input',{bubbles:true}));return {ok:true};}" +
    "return {ok:false,message:'element is not fillable (tag='+tag+')'};" +
    "})()"
  );
}

/**
 * 新标签页注入脚本：在 about:blank 上画出收藏夹磁贴网格（Edge NTP 风格）。
 * 全程 DOM API（textContent/setAttribute），书签标题不外插 HTML，避免注入。
 */
function NEW_TAB_SCRIPT(itemsJson: string): string {
  const css =
    "html,body{height:100%;margin:0;}" +
    "body{font:13px Segoe UI,Microsoft YaHei,sans-serif;background:#f9f9f9;color:#1f1f1f;" +
    "display:flex;flex-direction:column;align-items:center;user-select:none;}" +
    ".ntp{margin-top:14vh;max-width:760px;text-align:center;}" +
    ".grid{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;}" +
    "a.tile{display:flex;flex-direction:column;align-items:center;gap:8px;width:88px;" +
    "padding:12px 6px;border-radius:10px;text-decoration:none;color:inherit;}" +
    "a.tile:hover{background:rgba(128,128,128,.14);}" +
    ".ic{width:44px;height:44px;border-radius:10px;background:#fff;display:flex;" +
    "align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.14);" +
    "font-size:18px;font-weight:600;color:#5f6368;overflow:hidden;}" +
    ".ic img{width:22px;height:22px;}" +
    ".t{max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;}" +
    ".empty{color:#8a8a8a;}" +
    "@media(prefers-color-scheme:dark){" +
    "body{background:#202020;color:#e8e8e8;}" +
    ".ic{background:#2f2f2f;color:#a6a6a6;}" +
    "a.tile:hover{background:rgba(255,255,255,.09);}}";
  return (
    "(function(){" +
    // dom-ready 触发后 executeJavaScript 可能落到已导航的新文档上
    // （main 侧的 getURL 检查与脚本执行之间存在竞态），必须在页面内再判一次。
    "if(location.href!=='about:blank')return;" +
    "var items=" + itemsJson + "||[];" +
    "document.title='新标签页';" +
    "var st=document.createElement('style');st.textContent='" + css + "';" +
    "document.head.appendChild(st);" +
    "var root=document.createElement('div');root.className='ntp';" +
    "var grid=document.createElement('div');grid.className='grid';" +
    "if(!items.length){" +
    "var em=document.createElement('div');em.className='empty';" +
    "em.textContent='点地址栏右侧 ☆ 收藏常用网站，会显示在这里';" +
    "root.appendChild(em);" +
    "}else{" +
    "for(var i=0;i<items.length;i++){" +
    "var b=items[i];" +
    "var a=document.createElement('a');a.className='tile';a.href=b.url;a.title=b.title||b.url;" +
    "var ic=document.createElement('span');ic.className='ic';" +
    "if(b.favicon){var im=document.createElement('img');im.src=b.favicon;" +
    "im.onerror=function(){this.style.display='none'};ic.appendChild(im);}" +
    "else{ic.textContent=(b.title||b.url).replace(/^https?:\\/\\//,'').slice(0,1).toUpperCase();}" +
    "var t=document.createElement('span');t.className='t';t.textContent=b.title||b.url;" +
    "a.appendChild(ic);a.appendChild(t);grid.appendChild(a);" +
    "}" +
    "root.appendChild(grid);" +
    "}" +
    "document.body.appendChild(root);" +
    "})()"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
