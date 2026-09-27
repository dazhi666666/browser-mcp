# browser-mcp

把 ZCode 桌面端的内置浏览器 + 操控能力抽成独立 Electron 应用，其它 Agent（OpenCode、Claude Code 等）通过 MCP 操控。用户可在窗口中实时观看并手动介入。

## 快速开始

要求：Node ≥ 20（构建与 shim 用；浏览器运行时是 Electron 自带）。Windows/macOS/Linux 均可。

```bash
git clone https://github.com/dazhi666666/browser-mcp.git
cd browser-mcp
npm install        # 首次会下载 Electron 二进制（约 100MB）
npm run dev        # tsc 构建 + 启动窗口
```

然后在 Agent 软件里把 `shim/index.mjs` 挂为 MCP server（stdio），以 OpenCode 的
`opencode.json` 为例（路径换成你的克隆位置）：

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["node", "/path/to/browser-mcp/shim/index.mjs"],
      "enabled": true,
      "environment": {
        "BROWSER_MCP_APP_CMD": "\"/path/to/browser-mcp/node_modules/electron/dist/electron\" \"/path/to/browser-mcp\""
      }
    }
  }
}
```

`BROWSER_MCP_APP_CMD` 可选：配上后 App 未运行时 shim 会自动拉起（等 20s），
不配则需先手动 `npm run dev`。Electron 可执行文件路径：
Windows = `node_modules/electron/dist/electron.exe`，
macOS = `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`，
Linux = `node_modules/electron/dist/electron`。

验证接入：让 agent 调 `browser_navigate url=https://example.com`——窗口应出现
该页面；或跑 `node scripts/smoke-shim.mjs`（App 需已启动）。

支持 streamable-HTTP 的 client 可直连 `http://127.0.0.1:<port>/mcp`（Bearer
token 与端口见 `~/.browser-mcp/server.json`）。更多 client 配置示例见下文
「Agent 接入」。

## 架构

```
Agent (MCP client)
  ├─ streamable-HTTP → http://127.0.0.1:<port>/mcp  (Bearer token)
  └─ stdio → shim/index.mjs ─┘ (读 ~/.browser-mcp/server.json 转发)

Electron App
  main:
    http server (/mcp MCP, /command 调试口, /tabs, /history, /bookmarks,
                 /ui.png chrome 截图, /health)
    TabManager      — main 持有 WebContentsView；tab 生命周期、CDP attach、
                      Page.enable、dialog 追踪、viewport override、崩溃重建、
                      导航事件 → HistoryStore、scope 分组隔离（AgentScope）
    userData.ts     — HistoryStore / BookmarkStore（~/.browser-mcp/*.json，
                      防抖写盘 + will-quit flush）
    browser/*       — ZCode browserView executor 层（几乎零改动移植）
  renderer: Edge 风格 UI — tab 条占满标题栏（titleBarOverlay 原生窗口按钮）、
            tab group chip（彩色竖条+组名，点击折叠）、
            导航栏（后退/前进/刷新 + omnibox + ☆收藏 + ☆≡收藏夹 + 🕘历史 + ⋯菜单）、
            右侧停靠面板（收藏夹/历史/菜单）、新标签页收藏磁贴（main 注入 about:blank）、
            agent 操作指示条（agent:busy → "Agent 操作中" 呼吸灯）
```

`src/main/browser/` 和 `src/shared/browser-use/` 移植自 `../ZCode`（Apache-2.0），
executor 只依赖 `ControlledView` 抽象（webContents + CDP send + 截图钩子）。

## 运行

```bash
npm install
npm run dev        # tsc + electron .
```

注意：本机环境若存在 `ELECTRON_RUN_AS_NODE=1`（WSL 透传），需先清除再启动。

启动后写 `~/.browser-mcp/server.json`：`{port, token, pid}`，HTTP 端点要求
`Authorization: Bearer <token>`。

## 数据持久化

| 数据 | 位置 | 说明 |
|---|---|---|
| Cookie / localStorage / IndexedDB | `userData/Partitions/browser-mcp/`（Chromium 管理） | `persist:` session partition，天然落盘，登录态跨重启保留 |
| 浏览历史 | `~/.browser-mcp/history.json` | did-navigate + did-navigate-in-page 记录，封顶 5000 条 |
| 收藏夹 | `~/.browser-mcp/bookmarks.json` | 扁平列表按 url 去重 |

## Agent 接入

**支持 streamable-HTTP 的 client**：直接连 `http://127.0.0.1:<port>/mcp`，带 Bearer token。

**只支持 stdio 的 client（如 OpenCode）**：配 shim 进程。

**Devin CLI / Devin Desktop**：在工作区根目录放 `.devin/mcp_config.local.json`：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["D:\\Browser MCP\\browser-mcp\\shim\\index.mjs"],
      "env": {
        "BROWSER_MCP_APP_CMD": "\"D:\\Browser MCP\\browser-mcp\\node_modules\\electron\\dist\\electron.exe\" \"D:\\Browser MCP\\browser-mcp\""
      }
    }
  }
}
```

Devin 会热加载配置，工具以 `mcp__browser__*` 出现。已实测 navigate→snapshot→click 全链路。

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["node", "D:\\Browser MCP\\browser-mcp\\shim\\index.mjs"],
      "enabled": true,
      "environment": {
        "BROWSER_MCP_APP_CMD": "\"D:\\Browser MCP\\browser-mcp\\node_modules\\electron\\dist\\electron.exe\" \"D:\\Browser MCP\\browser-mcp\""
      }
    }
  }
}
```

`BROWSER_MCP_APP_CMD` 可选：App 未运行时 shim 会自动拉起并等待（20s）。

shim 还支持两个分组相关环境变量：`BROWSER_MCP_CLIENT`（覆盖上报的 client 名，
默认透传下游 clientInfo.name）与 `BROWSER_MCP_GROUP`（固定本 shim 会话的
thread 名——同一 OpenCode 项目/配置下的重连会落回同一分组）。

## 分组（tab group）

每个 agent 线程的 tab 收进一个 Edge 式分组：tab 条上显示彩色 chip
（竖条 + 组名，点击折叠成 `组名 · N`），组员 tab 底缘挂同色彩条。

- **分组身份 = client + thread**（对应 ZCode 的 workspaceKey+sessionId scope）：
  - `client`：`x-bmcp-client` 头 > MCP `clientInfo.name`（shim 自动透传下游真实
    client 名，如 `opencode`）> `"agent"`
  - `thread`：单条调用的 `group` 参数 > `browser_scope` set > `x-bmcp-group` 头
    （shim 的 `BROWSER_MCP_GROUP`）> MCP session id
- **隔离**：`browser_tabs list` 只见本组 tab + 可认领的 user tab；
  显式 tabId 指向其它组的 tab → `backend_unavailable: belongs to another group`；
  无 tabId 的命令落在本组最近使用的 tab（找不到则自动新建入组 tab）。
- **user tab**：UI 手工开的 tab 无组，任何 scope 首次用显式 tabId 寻址时
  隐式 claim 进组（对应 ZCode 的 claimTab；也可用 `browser_tabs action=claim`）。
- **归还**：`markDeliverable`/`finalize`/`closeSession` 把 tab 释放回 user tab
  （页面保留、脱离分组）。MCP session 收到 DELETE（显式 terminate）时也会
  对该 session 寻址过的所有分组执行 closeSession。
- **孤儿分组（session 死亡检测）**：MCP 客户端断开通常不发 DELETE（SDK 的
  `client.close()` 只 abort standalone SSE），所以存活判定不看 transport
  开关而看 SSE 流：挂过 SSE 的 session 断开超过
  `BROWSER_MCP_ORPHAN_GRACE_MS`（默认 15s）即判死；从未挂 SSE 的纯 POST
  客户端按 `BROWSER_MCP_SESSION_TTL_MS`（默认 30min）无活动判死。
  死亡 session 的分组保留（chip 不消失），但其 tab 变成**孤儿 tab**：
  `browser_tabs list` 的 `orphanTabs` 字段可见，任意存活 scope 可
  `claim` 或用显式 tabId 寻址时隐式接管进自己的组。
- **跨会话连续性**：要"重连后仍回到同一分组"（比如 OpenCode 同一对话），
  用 `BROWSER_MCP_GROUP`/`x-bmcp-group`/`browser_scope set group=` 固定
  thread 名；默认 thread=MCP session id，新会话永远是新分组（此时旧分组的
  tab 走上面的孤儿接管路径）。
- **命名**：`browser_scope set name=...`（或 `nameSession` 命令）改组名，
  未命名时显示 `client·thread前8位`；`browser_scope get` 查当前组信息。
- **注意**：thread 是软身份（agent 自报），不是安全边界——同机协作场景够用；
  不要让不可信客户端连这个端口。

## 界面

Edge 风格 chrome（88px = tab 条 40 + 导航栏 48；侧面板占右 340 时 renderer 经
`chrome:layout` IPC 上报，`TabManager.setChromeLayout` 缩小页面 view 宽度）：

- 上排 40px tab 条，占满标题栏（`titleBarStyle:"hidden"` + `titleBarOverlay`，
  右上角保留原生最小化/最大化/关闭）；tab 含 favicon、加载圈、×，中键关闭，
  活动 tab 白色并融入下方导航栏。tab 条空白处可拖动窗口。
- 48px 导航栏：后退/前进/刷新按钮（按 navigationHistory 置灰）、
  omnibox（https 锁图标 / http 警告 / 输入非域名时走 Bing 搜索）、
  omnibox 内 ☆ 收藏切换、☆≡ 收藏夹按钮、🕘 历史按钮、⋯ 菜单、Agent 呼吸灯。
- 新标签页（Edge NTP 风格）：新建/空 tab 的 about:blank 由 main 进程 `dom-ready`
  时注入收藏夹磁贴网格（favicon 圆角图标 + 标题，最多 12 个），点击即导航。
- 右侧停靠面板（340px）：收藏夹列表 / 历史记录（按天分组 + 搜索 + 单条删除）/
  菜单动作（含「开机自动启动」开关，`app.setLoginItemSettings`——Windows 写
  注册表 Run 键；开发模式下拉起 `electron.exe + 仓库路径`）。**停靠而非浮层**
  ——renderer 画在页面区的任何内容都会被 WebContentsView
  原生层遮住（早期下拉菜单底部被截就是这个原因），所以面板占位、页面让宽。
- 跟随系统明暗色（`nativeTheme` → CSS `prefers-color-scheme` + overlay 颜色同步，
  NTP 磁贴页同样跟随）。
- 快捷键：Ctrl+T/W/L/R/D/H、Ctrl+Shift+O、Alt+←/→、F5、F12、Esc 关面板
  （焦点在 chrome 上时生效；页面内按键仍由页面处理）。
- 调试端点 `GET /ui.png`：截 chrome 层。注意 `WebContentsView` 是独立合成层，
  不属于该 document，截图中页面区呈空白——这是 capturePage 的固有限制，不是 bug。
- 窗口图标：`assets/icon.ico`（16–256 PNG 内嵌）。设计稿是 `assets/icon.html` 的
  SVG（地球 + 光标箭头 + 闪光），`scripts/make-icon.mjs` 借运行中的 App 页面对
  每个尺寸重渲染后封装 ICO——file:// 会被 navigation_blocked 拦，脚本内置临时 http。

## 工具面（32 个）

- 导航：`browser_navigate` `browser_back` `browser_forward` `browser_reload`
- 读取：`browser_snapshot`（ref 快照）`browser_dom_snapshot`（ARIA 树文本）
  `browser_take_screenshot`（image content）`browser_get_state` `browser_element_info` `browser_evaluate`
- 交互：`browser_click` `browser_type` `browser_fill` `browser_press` `browser_keypress`
  `browser_hover` `browser_select_option` `browser_check` `browser_drag` `browser_scroll`
- 等待：`browser_wait_for` `browser_wait` `browser_wait_for_load_state` `browser_wait_for_url`
- Dialog：`browser_get_dialog` `browser_handle_dialog`
- Tab/窗口：`browser_tabs`（list/new/activate/close/claim）`browser_resize`
  `browser_viewport_reset` `browser_set_visible` `browser_scope`（分组 get/set）
- 高级：`browser_locator`（Playwright selector + operation 透传）

所有工具接受可选 `group` 参数：单次调用覆盖 thread 身份（共享同一 MCP session 的
多线程可借此保持分组独立）。

典型 agent 流：`snapshot`（拿 e1..eN ref）→ `click`/`fill`/`type` by ref → `screenshot` 或
`dom_snapshot` 复核。

## 冒烟测试

```bash
node scripts/smoke-mcp.mjs    # HTTP MCP 全链路
node scripts/smoke-shim.mjs   # stdio shim 代理
node scripts/probe-evaluate.cjs "<expr>"   # evaluate 探针
node scripts/make-icon.mjs    # 重新生成 assets/icon.ico（需 App 运行中，借页面渲染 SVG 设计稿）
```

## 关键实现细节 / 坑

- **Windows 遮挡**：`CalculateNativeWinOcclusion` 会让被完全遮挡窗口的合成器停摆，
  截图报 "display surface not available"、CDP Input 事件被静默丢弃。已通过
  `disable-features` + `backgroundThrottling:false` 规避——不得移除。
- **窗口最小化**：遮挡开关不覆盖"最小化"（页面仍标 hidden，Input 被丢）。
  采用**假最小化**：`main.ts` 拦截 `minimize` 事件 → `restore()` + 停到当前
  显示器右下角、只留 2×2 px 在屏内——肉眼不可见，但 viz 合成表面保持存活
  （完全离屏 -32000 会丢表面，capturePage 报 UnknownVizError/挂起且不可恢复），
  agent 指令照常生效且窗口不弹回；
  用户点任务栏图标经 `focus` 事件移回原位置（含 maximized 状态）。
  `browserVisibilitySet(false)` 同样走停靠而非 `hide()`。
- **CDP session 态**：`debugger.attach` 后必须补发 `Page.enable`，否则 JS dialog
  事件黑洞、evaluate 遇 dialog 挂起。dialog 走 `Page.javascriptDialogOpening` 事件
  + `Page.handleJavaScriptDialog`；无人处理时 60s 自动 dismiss。
- **viewport**：`browser_resize` 用 `Emulation.setDeviceMetricsOverride`
  + `dontSetVisibleSize:true`，只改页面 CSS 视口不动窗口。
- **evaluate** 入参是表达式（被 `return (EXPR)` 包装），传语句会 SyntaxError。
- **ESM main**：`electron` 需 default import 再解构。
- **MCP SDK 1.30**：每个 session 需要独立 `McpServer` 实例（Server 只能 connect 一个 transport）。
- **ref 生命周期**：snapshot ref 存在 `window.__zcodeRefs`，导航即失效——agent 需重新 snapshot。
- **chrome 与页面是两个合成层**：renderer 下拉的浮层会被 WebContentsView 遮住，
  一切弹出 UI（历史/收藏夹/菜单）都必须用停靠面板或收缩页面区实现；
  布局变化一律走 `chrome:layout` IPC → `TabManager.setChromeLayout`。
- **历史记录**：`did-navigate` / `did-navigate-in-page` 追加（连续同 url 只更新时间戳），
  `page-title-updated` / `page-favicon-updated` 回写最新条目的标题与 favicon；
  about:blank / devtools 不入库。
- **新标签页磁贴**：`newTab()` 必须显式 `loadURL("about:blank")`——不加载就没有已提交
  document（`getURL()` 返回 `""`），`dom-ready` 不触发注入，evaluate 也会挂起。
  注入脚本用 DOM API + JSON.stringify 数据，标题不外插 HTML。
  注意注入竞态：dom-ready 到 executeJavaScript 之间页面可能已导航，
  脚本内部必须再判 `location.href==='about:blank'`，否则会把标题写进新页面。
- **分组 scope**：`TabManager.execute(scope, command)` 的 scope={client,thread}；
  resolveTab 语义与 ZCode 一致（显式 tabId 验同组/隐式 claim、无 tabId 回落本组
  最近 tab 或自动建组内 tab）。同组 tab 由 `moveAfterGroupMates` 保持连续，
  renderer 按 groupId 切 run 渲染 chip——不要在 renderer 侧自行排序。
- **分组持久性**：groupId=client\0thread 是运行时身份不落盘；重启后 tab 全是
  user tab，agent 重新寻址会再次隐式 claim。
- **单实例**：`app.requestSingleInstanceLock()` 必须保留——重复启动（双击 / shim
  拉起 / login item）产生的第二实例会因 userData profile 争用渲染成全白窗口；
  `second-instance` 事件回调里用 `bringToFront` 把已有窗口唤回（含解除停靠态）。

## 未实现 / 后续

- `recording*`（webm 录屏）：返回 capability_unsupported，可搬 `electronBrowserWebmRecorder.ts`
- `browser_locator` 的 `fileChooserSetFiles`/`downloadPath`/`waitForEvent`：IAB 后端不支持
- OS 级 CUA（浏览器外键鼠）：ZCode 闭源 helper，不在本仓库；自研时往 TabManager.execute
  挂新 method 即可，MCP 层无协议改动
- 打包分发：electron-builder 未配置
- 分组规则见上文「分组」：MCP session 级隔离已实现；同一进程内共享 MCP session
  的多线程需 agent 侧自报 `group` 参数或用 `BROWSER_MCP_GROUP` 区分
