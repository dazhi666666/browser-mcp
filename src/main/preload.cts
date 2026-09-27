import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("browserMcp", {
  listTabs: () => ipcRenderer.invoke("tabs:list"),
  newTab: (url?: string) => ipcRenderer.invoke("tabs:new", url),
  activateTab: (tabId: string) => ipcRenderer.invoke("tabs:activate", tabId),
  closeTab: (tabId: string) => ipcRenderer.invoke("tabs:close", tabId),
  navigateActive: (url: string) => ipcRenderer.invoke("tabs:navigate", url),
  goBack: () => ipcRenderer.invoke("nav:back"),
  goForward: () => ipcRenderer.invoke("nav:forward"),
  reload: () => ipcRenderer.invoke("nav:reload"),
  openDevTools: () => ipcRenderer.invoke("tabs:devtools"),
  setChromeLayout: (layout: { top?: number; right?: number }) =>
    ipcRenderer.invoke("chrome:layout", layout),
  listHistory: (limit?: number) => ipcRenderer.invoke("history:list", limit),
  removeHistory: (id: string) => ipcRenderer.invoke("history:remove", id),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  listBookmarks: () => ipcRenderer.invoke("bookmarks:list"),
  toggleBookmark: (entry: { url: string; title: string; favicon?: string }) =>
    ipcRenderer.invoke("bookmarks:toggle", entry),
  removeBookmark: (id: string) => ipcRenderer.invoke("bookmarks:remove", id),
  onTabsChanged: (cb: () => void) => ipcRenderer.on("tabs:changed", () => cb()),
  onAgentBusy: (cb: (busy: boolean) => void) =>
    ipcRenderer.on("agent:busy", (_e, busy: boolean) => cb(busy)),
  onBookmarksChanged: (cb: () => void) => ipcRenderer.on("bookmarks:changed", () => cb()),
});
