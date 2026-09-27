const api = window.browserMcp;
const tabsEl = document.getElementById("tabs");
const addressEl = document.getElementById("address");
const busyEl = document.getElementById("busy");
const secIconEl = document.getElementById("secIcon");
const backBtn = document.getElementById("back");
const fwdBtn = document.getElementById("fwd");
const starEl = document.getElementById("star");
const panelEl = document.getElementById("panel");
const panelTitleEl = document.getElementById("panelTitle");
const panelBodyEl = document.getElementById("panelBody");

const CHROME_BASE = 88; // tabbar 40 + navbar 48
const PANEL_W = 340;

let tabs = [];
let bookmarks = [];
let panelMode = null; // 'favorites' | 'history' | 'menu'
// Edge 式 tab group：折叠状态按 groupId 记在 renderer 本地（纯 UI 态，不回 main）。
const collapsedGroups = new Set();

const ICONS = {
  globe:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/></svg>',
  lock:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  info:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  close:
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// chrome 占位上报：侧面板开合改变 right，main 据此缩小 WebContentsView
//（面板是停靠式，不是浮层——renderer 画在页面区的内容会被原生 view 遮住）。
function reportLayout() {
  const right = panelMode ? PANEL_W : 0;
  panelEl.style.top = CHROME_BASE + "px";
  api.setChromeLayout({ top: CHROME_BASE, right });
}

// ---------------------------------------------------------------- tabs

async function refresh() {
  tabs = await api.listTabs();
  render();
}

function activeTab() {
  return tabs.find((t) => t.active);
}

function faviconEl(iconHost, favicon, isLoading) {
  iconHost.className = "favicon";
  if (isLoading) {
    iconHost.innerHTML = '<span class="spinner"></span>';
  } else if (favicon) {
    const img = document.createElement("img");
    img.src = favicon;
    img.onerror = () => {
      iconHost.innerHTML = ICONS.globe;
    };
    iconHost.append(img);
  } else {
    iconHost.innerHTML = ICONS.globe;
  }
}

function tabEl(tab) {
  const el = document.createElement("div");
  el.className = "tab" + (tab.active ? " active" : "");
  el.title = tab.title ? tab.title + "\n" + tab.url : tab.url;
  if (tab.group) {
    el.classList.add("gm");
    el.style.setProperty("--gc", tab.group.color);
  }

  const icon = document.createElement("span");
  faviconEl(icon, tab.favicon, tab.isLoading);

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = tab.title || (tab.url && tab.url !== "about:blank" ? tab.url : "新标签页");

  const close = document.createElement("button");
  close.className = "close";
  close.title = "关闭标签页";
  close.innerHTML = ICONS.close;
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    api.closeTab(tab.tabId);
  });

  el.append(icon, title, close);
  el.addEventListener("click", () => api.activateTab(tab.tabId));
  el.addEventListener("auxclick", (e) => {
    if (e.button === 1) api.closeTab(tab.tabId);
  });
  return el;
}

// Edge 式分组 chip：彩色竖条 + 组名；折叠后只留 chip（附成员数），点击切换。
function groupChipEl(group, count, collapsed) {
  const el = document.createElement("div");
  el.className = "tgroup" + (collapsed ? " collapsed" : "");
  el.style.setProperty("--gc", group.color);
  el.title = `分组「${group.label}」· ${count} 个标签页 — 点击${collapsed ? "展开" : "折叠"}`;

  const bar = document.createElement("span");
  bar.className = "gbar";

  const label = document.createElement("span");
  label.className = "glabel";
  label.textContent = collapsed ? `${group.label} · ${count}` : group.label;

  el.append(bar, label);
  el.addEventListener("click", () => {
    if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id);
    else collapsedGroups.add(group.id);
    render();
  });
  el.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
      if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id);
      else collapsedGroups.add(group.id);
      render();
    }
  });
  return el;
}

function render() {
  tabsEl.textContent = "";
  // 同组 tab 在 main 侧已保证连续；按 groupId 切 run，run 前插分组 chip。
  for (let i = 0; i < tabs.length; ) {
    const group = tabs[i].group;
    if (!group) {
      tabsEl.append(tabEl(tabs[i]));
      i += 1;
      continue;
    }
    let j = i;
    while (j < tabs.length && tabs[j].group && tabs[j].group.id === group.id) j += 1;
    const run = tabs.slice(i, j);
    const collapsed = collapsedGroups.has(group.id);
    tabsEl.append(groupChipEl(group, run.length, collapsed));
    if (!collapsed) for (const t of run) tabsEl.append(tabEl(t));
    i = j;
  }

  const active = activeTab();
  if (document.activeElement !== addressEl) {
    addressEl.value = active && active.url !== "about:blank" ? active.url : "";
  }
  backBtn.disabled = !active?.canGoBack;
  fwdBtn.disabled = !active?.canGoForward;

  const url = active?.url ?? "";
  if (url.startsWith("https:")) {
    secIconEl.innerHTML = ICONS.lock;
    secIconEl.className = "";
    secIconEl.title = "连接是安全的";
  } else if (url.startsWith("http:")) {
    secIconEl.innerHTML = ICONS.info;
    secIconEl.className = "warn";
    secIconEl.title = "连接不安全";
  } else {
    secIconEl.innerHTML = ICONS.globe;
    secIconEl.className = "";
    secIconEl.title = "";
  }
  renderStar();
}

// 地址栏：域名形态直接导航，其余走 Bing 搜索（对齐 Edge 的 omnibox 行为）
function toUrl(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;
  if (/^localhost(:\d+)?([/?#]|$)/.test(s)) return s;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(s)) return s;
  if (!/\s/.test(s) && /^[^\s]+\.[^\s]{2,}$/.test(s)) return s;
  return "https://www.bing.com/search?q=" + encodeURIComponent(s);
}

function submitAddress() {
  const url = toUrl(addressEl.value);
  if (url) api.navigateActive(url);
  addressEl.blur();
}

// ---------------------------------------------------------------- 收藏夹

function renderStar() {
  const active = activeTab();
  const url = active?.url ?? "";
  const bookmarked = !!url && url !== "about:blank" && !!bookmarks.find((b) => b.url === url);
  starEl.disabled = !url || url === "about:blank";
  starEl.classList.toggle("on", bookmarked);
  starEl.querySelector("path").setAttribute("fill", bookmarked ? "currentColor" : "none");
  starEl.title = bookmarked ? "已收藏，点击移除 (Ctrl+D)" : "将此页添加到收藏夹 (Ctrl+D)";
}

async function toggleBookmark() {
  const active = activeTab();
  if (!active || !active.url || active.url === "about:blank") return;
  const res = await api.toggleBookmark({
    url: active.url,
    title: active.title || active.url,
    favicon: active.favicon,
  });
  await loadBookmarks();
  return res;
}

async function loadBookmarks() {
  bookmarks = await api.listBookmarks();
  renderStar();
  if (panelMode === "favorites") renderPanelBody();
}

// ---------------------------------------------------------------- 侧面板

const PANEL_TITLES = { favorites: "收藏夹", history: "历史记录", menu: "设置及更多" };

function openPanel(mode) {
  panelMode = panelMode === mode ? null : mode;
  renderPanel();
}

function renderPanel() {
  panelEl.hidden = !panelMode;
  if (!panelMode) {
    reportLayout();
    return;
  }
  panelTitleEl.textContent = PANEL_TITLES[panelMode];
  renderPanelBody();
  reportLayout();
}

function renderPanelBody() {
  panelBodyEl.textContent = "";
  if (panelMode === "history") renderHistoryPanel();
  else if (panelMode === "favorites") renderFavoritesPanel();
  else renderMenuPanel();
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "今天";
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function timeLabel(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function renderHistoryPanel(filter) {
  const entries = await api.listHistory(2000);
  const q = (filter ?? "").trim().toLowerCase();
  const list = q
    ? entries.filter(
        (e) => e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q),
      )
    : entries;

  const search = document.createElement("input");
  search.id = "panelSearch";
  search.placeholder = "搜索历史记录";
  search.value = filter ?? "";
  search.addEventListener("input", () => {
    const v = search.value;
    panelBodyEl.textContent = "";
    renderHistoryPanel(v);
    const el = document.getElementById("panelSearch");
    el.focus();
    el.setSelectionRange(v.length, v.length);
  });
  panelBodyEl.append(search);

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pempty";
    empty.textContent = q ? "没有匹配的记录" : "暂无浏览历史";
    panelBodyEl.append(empty);
    return;
  }

  let lastDay = "";
  for (const e of list) {
    const day = dayLabel(e.visitedAt);
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement("div");
      h.className = "phead";
      h.textContent = day;
      panelBodyEl.append(h);
    }
    const item = document.createElement("div");
    item.className = "pitem";
    item.title = e.url;

    const icon = document.createElement("span");
    faviconEl(icon, e.favicon, false);

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = e.title || e.url;
    const u = document.createElement("div");
    u.className = "u";
    u.textContent = `${timeLabel(e.visitedAt)} · ${e.url}`;
    meta.append(t, u);

    const x = document.createElement("button");
    x.className = "x";
    x.title = "删除此记录";
    x.innerHTML = ICONS.close;
    x.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await api.removeHistory(e.id);
      renderPanelBody();
    });

    item.append(icon, meta, x);
    item.addEventListener("click", () => api.navigateActive(e.url));
    item.addEventListener("auxclick", (ev) => {
      if (ev.button === 1) api.newTab(e.url);
    });
    panelBodyEl.append(item);
  }
}

function renderFavoritesPanel() {
  if (bookmarks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pempty";
    empty.textContent = "暂无收藏 — 点地址栏右侧 ☆ 收藏当前页";
    panelBodyEl.append(empty);
    return;
  }
  for (const b of bookmarks) {
    const item = document.createElement("div");
    item.className = "pitem";
    item.title = b.url;

    const icon = document.createElement("span");
    faviconEl(icon, b.favicon, false);

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = b.title || b.url;
    const u = document.createElement("div");
    u.className = "u";
    u.textContent = b.url;
    meta.append(t, u);

    const x = document.createElement("button");
    x.className = "x";
    x.title = "删除";
    x.innerHTML = ICONS.close;
    x.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await api.removeBookmark(b.id);
      await loadBookmarks();
    });

    item.append(icon, meta, x);
    item.addEventListener("click", () => api.navigateActive(b.url));
    item.addEventListener("auxclick", (ev) => {
      if (ev.button === 1) api.newTab(b.url);
    });
    panelBodyEl.append(item);
  }
}

function renderMenuPanel() {
  const action = (label, kbd, fn) => {
    const b = document.createElement("button");
    b.className = "paction";
    const l = document.createElement("span");
    l.textContent = label;
    const r = document.createElement("span");
    r.className = "kbd";
    r.textContent = kbd;
    b.append(l, r);
    b.addEventListener("click", fn);
    panelBodyEl.append(b);
  };
  const sep = () => {
    const s = document.createElement("div");
    s.className = "psep";
    panelBodyEl.append(s);
  };

  action("收藏夹", "Ctrl+Shift+O", () => openPanel("favorites"));
  action("历史记录", "Ctrl+H", () => openPanel("history"));
  sep();
  action("开发者工具", "F12", () => api.openDevTools());
  action("重新加载界面", "", () => location.reload());
  sep();
  // 开机自动启动开关：勾选态由系统 login item 读回（Windows 注册表 Run 键）。
  const loginBtn = document.createElement("button");
  loginBtn.className = "paction";
  const loginLabel = document.createElement("span");
  loginLabel.textContent = "开机自动启动";
  const loginMark = document.createElement("span");
  loginMark.className = "kbd";
  loginBtn.append(loginLabel, loginMark);
  let loginOn = false;
  const renderLoginMark = () => {
    loginMark.textContent = loginOn ? "✓" : "";
  };
  api.getLaunchAtLogin().then((v) => {
    loginOn = !!v;
    renderLoginMark();
  });
  loginBtn.addEventListener("click", async () => {
    loginOn = !!(await api.setLaunchAtLogin(!loginOn));
    renderLoginMark();
  });
  panelBodyEl.append(loginBtn);
  sep();
  action("清除浏览历史", "", async () => {
    await api.clearHistory();
    if (panelMode === "history") renderPanelBody();
  });
}

// ---------------------------------------------------------------- 事件

// 新标签页会展示收藏夹磁贴（about:blank 由 main 注入），建完顺手聚焦地址栏
function openNewTab() {
  api.newTab();
  addressEl.focus();
}
document.getElementById("newTab").addEventListener("click", openNewTab);
document.getElementById("reload").addEventListener("click", () => api.reload());
backBtn.addEventListener("click", () => api.goBack());
fwdBtn.addEventListener("click", () => api.goForward());
starEl.addEventListener("click", toggleBookmark);
document.getElementById("favBtn").addEventListener("click", () => openPanel("favorites"));
document.getElementById("histBtn").addEventListener("click", () => openPanel("history"));
document.getElementById("menuBtn").addEventListener("click", () => openPanel("menu"));
document.getElementById("panelClose").addEventListener("click", () => {
  panelMode = null;
  renderPanel();
});
addressEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitAddress();
  else if (e.key === "Escape") {
    const active = activeTab();
    addressEl.value = active && active.url !== "about:blank" ? active.url : "";
    addressEl.blur();
  }
});
addressEl.addEventListener("focus", () => addressEl.select());

// 快捷键
document.addEventListener("keydown", (e) => {
  const active = activeTab();
  const key = e.key.toLowerCase();
  if (e.key === "F12") api.openDevTools();
  else if (e.key === "Escape" && panelMode) {
    panelMode = null;
    renderPanel();
  } else if (e.ctrlKey && key === "l") {
    addressEl.focus();
    e.preventDefault();
  } else if (e.ctrlKey && key === "t") {
    openNewTab();
    e.preventDefault();
  } else if (e.ctrlKey && key === "w") {
    if (active) api.closeTab(active.tabId);
    e.preventDefault();
  } else if ((e.ctrlKey && key === "r") || e.key === "F5") {
    api.reload();
    e.preventDefault();
  } else if (e.ctrlKey && key === "d") {
    toggleBookmark();
    e.preventDefault();
  } else if (e.ctrlKey && key === "h") {
    openPanel("history");
    e.preventDefault();
  } else if (e.ctrlKey && e.shiftKey && key === "o") {
    openPanel("favorites");
    e.preventDefault();
  } else if (e.altKey && e.key === "ArrowLeft") {
    api.goBack();
    e.preventDefault();
  } else if (e.altKey && e.key === "ArrowRight") {
    api.goForward();
    e.preventDefault();
  }
});

api.onTabsChanged(refresh);
api.onAgentBusy((busy) => busyEl.classList.toggle("on", busy));
api.onBookmarksChanged(loadBookmarks);

loadBookmarks();
refresh();
reportLayout();
