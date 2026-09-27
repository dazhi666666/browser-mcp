import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const { app, BrowserWindow, ipcMain, session, nativeTheme, screen } = electron;
import { browserCommandSchema } from "../shared/index.js";
import { TabManager } from "./tabManager.js";
import { createMcpHttpHandler } from "./mcpServer.js";
import { HistoryStore, BookmarkStore } from "./userData.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISCOVERY_DIR = join(homedir(), ".browser-mcp");
const DISCOVERY_FILE = join(DISCOVERY_DIR, "server.json");
const HISTORY_FILE = join(DISCOVERY_DIR, "history.json");
const BOOKMARKS_FILE = join(DISCOVERY_DIR, "bookmarks.json");
const AUTH_TOKEN = randomUUID();

// Windows 遮挡检测会挂起被完全遮挡窗口的合成器与输入派发，
// 导致 capturePage "display surface not available" 且 CDP Input 事件被丢弃。
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let tabManager: TabManager;
let mcpHandler: ReturnType<typeof createMcpHttpHandler>;
const historyStore = new HistoryStore(HISTORY_FILE);
const bookmarkStore = new BookmarkStore(BOOKMARKS_FILE);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function startControlServer(win: Electron.BrowserWindow): Promise<number> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") return sendJson(res, 200, { ok: true });

      const auth = req.headers.authorization;
      if (auth !== `Bearer ${AUTH_TOKEN}`) {
        return sendJson(res, 401, { error: "unauthorized" });
      }

      // chrome UI（tab 条/导航栏）截图，用于验证窗口外观
      if (req.method === "GET" && url.pathname === "/ui.png") {
        const image = await win.webContents.capturePage();
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(image.toPNG());
      }

      // MCP streamable-HTTP 端点（POST 消息 / GET SSE / DELETE 会话终止）
      if (url.pathname === "/mcp") {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        return mcpHandler(req, res, body);
      }

      if (req.method === "GET" && url.pathname === "/tabs") {
        return sendJson(res, 200, { tabs: tabManager.list() });
      }
      if (req.method === "POST" && url.pathname === "/tabs") {
        const body = (await readBody(req)) as { url?: string };
        return sendJson(res, 200, { tabId: tabManager.newTab(body.url) });
      }
      if (req.method === "POST" && url.pathname === "/tabs/activate") {
        const body = (await readBody(req)) as { tabId?: string };
        const ok = body.tabId ? tabManager.activate(body.tabId) : false;
        return sendJson(res, ok ? 200 : 404, { ok });
      }
      if (req.method === "POST" && url.pathname === "/tabs/close") {
        const body = (await readBody(req)) as { tabId?: string };
        const ok = body.tabId ? tabManager.close(body.tabId) : false;
        return sendJson(res, ok ? 200 : 404, { ok });
      }
      if (req.method === "GET" && url.pathname === "/history") {
        return sendJson(res, 200, { history: historyStore.list(2000) });
      }
      if (req.method === "GET" && url.pathname === "/bookmarks") {
        return sendJson(res, 200, { bookmarks: bookmarkStore.list() });
      }
      if (req.method === "POST" && url.pathname === "/command") {
        const body = (await readBody(req)) as {
          command?: unknown;
          group?: unknown;
          client?: unknown;
        };
        const parsed = browserCommandSchema.safeParse(body.command);
        if (!parsed.success) {
          return sendJson(res, 400, {
            ok: false,
            error: { code: "invalid_command", message: parsed.error.message },
          });
        }
        // 调试口也走分组：{client:"debug", thread:group||"console"}；
        // 传 group 可模拟某个 agent 线程的分组。
        const scope = {
          client:
            typeof body.client === "string" && body.client.trim()
              ? body.client.trim()
              : "debug",
          thread:
            typeof body.group === "string" && body.group.trim()
              ? body.group.trim()
              : "console",
        };
        const result = await tabManager.execute(scope, parsed.data);
        return sendJson(res, 200, result);
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (error) {
      logger.error(`control server error: ${error}`);
      return sendJson(res, 500, { error: String(error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function writeDiscoveryFile(port: number): Promise<void> {
  await mkdir(DISCOVERY_DIR, { recursive: true });
  await writeFile(
    DISCOVERY_FILE,
    JSON.stringify({ port, token: AUTH_TOKEN, pid: process.pid }, null, 2),
    "utf-8",
  );
}

app.whenReady().then(async () => {
  // 去掉 Electron 标识，避免站点按异常 UA 处理
  const ses = session.fromPartition("persist:browser-mcp");
  ses.setUserAgent(ses.getUserAgent().replace(/ Electron\/[\d.]+/, ""));

  // Edge 风格：tab 条占满标题栏，右上角用 titleBarOverlay 的原生窗口按钮。
  const overlayColors = () => ({
    color: nativeTheme.shouldUseDarkColors ? "#1b1b1b" : "#dee1e6",
    symbolColor: nativeTheme.shouldUseDarkColors ? "#e8e8e8" : "#3b3b3b",
    height: 40,
  });
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 560,
    minHeight: 400,
    icon: join(__dirname, "../../assets/icon.ico"),
    titleBarStyle: "hidden",
    titleBarOverlay: overlayColors(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#2d2d2d" : "#ffffff",
    autoHideMenuBar: true,
    // loadFile 是异步的，先显示会闪一段白色背景；等 chrome 渲染完再亮相。
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // 不进入真正的 minimized 状态：minimized 窗口的页面被标 hidden，
  // CDP Input 事件会被静默丢弃。改为还原后把窗口停到屏幕外——
  // OS 认为窗口仍可见，合成器与输入照常；点任务栏图标经 focus 移回。
  let parked = false;
  let parking = false;
  let parkedAt = 0;
  let parkedBounds: Electron.Rectangle | undefined;
  let parkedMaximized = false;
  const parkWindow = () => {
    if (parked || parking) return;
    parking = true;
    parked = true;
    parkedAt = Date.now();
    parkedMaximized = win.isMaximized();
    parkedBounds = win.getNormalBounds();
    win.restore();
    // 不能把窗口完全移出屏幕：完全离屏的窗口会被丢弃 viz 合成表面，
    // 页面视图 capturePage 报 UnknownVizError/挂起（截图不可用），且恢复
    // 位置后表面也不会自动重建。改为停在当前显示器右下角、只留 2x2 px
    // 在屏内——肉眼不可见，但表面保持存活，停靠期间截图与输入仍可用。
    const wa = screen.getDisplayMatching(parkedBounds).workArea;
    win.setPosition(wa.x + wa.width - 2, wa.y + wa.height - 2);
    win.blur();
    setImmediate(() => {
      parking = false;
    });
  };
  const unparkWindow = () => {
    // 驻车过程中的 restore/focus 事件是异步到达的，短时窗内忽略避免误弹回
    if (!parked || parking || Date.now() - parkedAt < 500) return;
    parked = false;
    if (parkedMaximized) {
      win.maximize();
    } else if (parkedBounds) {
      win.setBounds(parkedBounds);
    }
    parkedBounds = undefined;
    parkedMaximized = false;
  };
  win.once("ready-to-show", () => win.show());
  win.on("minimize", parkWindow);
  win.on("focus", unparkWindow);
  nativeTheme.on("updated", () => {
    if (!win.isDestroyed()) win.setTitleBarOverlay(overlayColors());
  });

  const notifyChanged = () => {
    if (!win.isDestroyed()) win.webContents.send("tabs:changed");
  };
  const notifyBusy = (busy: boolean) => {
    if (!win.isDestroyed()) win.webContents.send("agent:busy", busy);
  };
  tabManager = new TabManager(
    win,
    notifyChanged,
    notifyBusy,
    { parkWindow, unparkWindow },
    historyStore,
    bookmarkStore,
  );
  mcpHandler = createMcpHttpHandler(tabManager);

  const notifyBookmarks = () => {
    if (!win.isDestroyed()) win.webContents.send("bookmarks:changed");
  };

  ipcMain.handle("tabs:list", () => tabManager.list());
  ipcMain.handle("tabs:new", (_e, url?: string) => tabManager.newTab(url));
  ipcMain.handle("tabs:activate", (_e, tabId: string) => tabManager.activate(tabId));
  ipcMain.handle("tabs:close", (_e, tabId: string) => tabManager.close(tabId));
  ipcMain.handle("tabs:navigate", (_e, url: string) => tabManager.navigateActive(url));
  ipcMain.handle("nav:back", () => tabManager.goBack());
  ipcMain.handle("nav:forward", () => tabManager.goForward());
  ipcMain.handle("nav:reload", () => tabManager.reloadActive());
  ipcMain.handle("tabs:devtools", () => tabManager.openDevTools());
  ipcMain.handle("chrome:layout", (_e, layout: { top?: number; right?: number }) =>
    tabManager.setChromeLayout(layout),
  );
  ipcMain.handle("history:list", (_e, limit?: number) => historyStore.list(limit));
  ipcMain.handle("history:remove", (_e, id: string) => historyStore.remove(id));
  ipcMain.handle("history:clear", () => historyStore.clear());
  ipcMain.handle("bookmarks:list", () => bookmarkStore.list());
  ipcMain.handle("bookmarks:toggle", (_e, entry: { url: string; title: string; favicon?: string }) => {
    const bookmarked = bookmarkStore.toggle(entry);
    notifyBookmarks();
    return { bookmarked };
  });
  ipcMain.handle("app:getLaunchAtLogin", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("app:setLaunchAtLogin", (_e, enabled: boolean) => {
    // 开发模式（非打包）下 execPath 是 electron.exe，需要把仓库根目录作为
    // 启动参数才能拉起本应用；打包后 app.isPackaged 时不需要参数。
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle("bookmarks:remove", (_e, id: string) => {
    const ok = bookmarkStore.remove(id);
    notifyBookmarks();
    return ok;
  });

  await win.loadFile(join(__dirname, "../../renderer/index.html"));
  tabManager.newTab();

  const port = await startControlServer(win);
  await writeDiscoveryFile(port);
  logger.info(`browser-mcp control server on http://127.0.0.1:${port}`);
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  historyStore.flushSync();
  bookmarkStore.flushSync();
});
