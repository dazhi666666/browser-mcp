# AGENTS.md

## 项目

browser-mcp：独立 Electron 应用，把 ZCode 的内置浏览器操控能力经 MCP 暴露给外部 Agent。
移植来源 `../ZCode`（Apache-2.0）：`src/shared/browser-use/`（zod 命令契约）与
`src/main/browser/`（页面 executor，`ControlledView` 抽象）。移植文件尽量保持原样，
便于后续对齐上游；通用能力缺口（fill/waitFor/对话框等）补在 `src/main/tabManager.ts`。

## 命令

```bash
npm install
npm run build      # tsc → dist/
npm run dev        # build + electron .
node scripts/smoke-mcp.mjs    # HTTP MCP 冒烟（需 App 已启动）
node scripts/smoke-shim.mjs   # stdio shim 冒烟
```

注意：若环境有 `ELECTRON_RUN_AS_NODE=1`，启动前清除（否则 electron 退化为纯 Node）。
WSL 里测 Windows 侧 HTTP：用 `curl.exe`/`node.exe`（WSL 内网不到 Windows 127.0.0.1）。

## 结构

- `src/main/main.ts` — 窗口、HTTP 端点（/mcp、/command、/tabs、/history、/bookmarks、/health）、`~/.browser-mcp/server.json`
- `src/main/tabManager.ts` — WebContentsView tab 管理 + manager 级命令分发 + 历史记录 + 动态 chrome 布局（唯一允许碰 Electron 的地方）
- `src/main/userData.ts` — HistoryStore/BookmarkStore（`~/.browser-mcp/*.json` 持久化，不 import electron）
- `src/main/mcpServer.ts` — MCP 工具注册（32 tools → BrowserCommand）+ /mcp sessionful 分发 + 每会话 AgentScope（clientInfo/headers → client+thread）
- `src/main/browser/*` — 移植的页面 executor；只依赖 ControlledView，不许 import electron
- `src/shared/*` — 移植的 zod 契约
- `shim/index.mjs` — stdio→HTTP MCP 代理（纯 ESM，无构建）
- `renderer/` — Edge 风格 chrome UI（tab 条 40px + 导航栏 48px = `TOOLBAR_HEIGHT`，无构建直接 loadFile）

## 规则

- 新增页面级能力优先走 `BrowserCommand` union + executor，不要绕过契约直接操控 webContents。
- MCP 工具名以 `browser_` 前缀；结果统一经 `toToolResult`（截图 → image content）。
- 页面内脚本禁反引号/`${}`（字符串拼接）；evaluate 只接受表达式。
- 新增工具时在 README「工具面」里登记。
- chrome 弹出 UI 不许用浮层（会被 WebContentsView 原生层遮住）：一律停靠面板/占位，
  尺寸变化走 `chrome:layout` IPC → `TabManager.setChromeLayout`。
- tab 分组：`TabManager.execute(scope, command)` 必须传 AgentScope（{client,thread}），
  不允许跨 scope 寻址其它组的 tab；user tab（UI 创建、groupId 为空）只能经
  resolveTab 隐式 claim 进组，不要直接改 groupId。同组 tab 必须经
  moveAfterGroupMates 保持连续（renderer 按连续 run 渲染 Edge 式 chip）。
- session 存活：`isScopeLive` 由 mcpServer 注入（SSE 断开宽限 / 纯 POST 的
  idle TTL）；死亡 session 的分组 tab 变孤儿（orphanTabs），resolveTab 显式
  寻址孤儿 tab 时隐式接管——与 user tab 同规则，不要为此开第三条路径。
  transport onclose（DELETE）时对该 session 寻址过的分组执行 closeSession。
- 页面 popup（target=_blank / window.open）由 `setWindowOpenHandler` 统一 deny 默认
  BrowserWindow，走 `openPopupTab` 改建本窗口 tab：继承来源 tab 的 groupId、
  background-tab disposition 不抢焦点、只允许 http/https/about 协议。
- dom-ready → executeJavaScript 之间存在导航竞态：页面注入脚本首行必须自查
  location.href，不能信 main 侧先验的 URL。
- 假最小化（parkWindow）不能把窗口完全移出屏幕：完全离屏会丢 viz 合成表面，
  capturePage 报 UnknownVizError/挂起且恢复位置后不自动重建。必须留 ≥2px 在
  屏内（见 main.ts parkWindow）。capturePage 一律加超时（挂起案例 >70s）。
