import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "./logger.js";

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  visitedAt: number;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  addedAt: number;
}

const HISTORY_LIMIT = 5_000;
const SAVE_DEBOUNCE_MS = 500;

/** JSON 文件持久化基类：启动读一次，变更防抖写盘，退出时 flushSync。 */
abstract class JsonStore<T> {
  protected items: T[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(protected file: string) {
    try {
      if (existsSync(file)) {
        const data = JSON.parse(readFileSync(file, "utf-8"));
        if (Array.isArray(data)) this.items = data;
      }
    } catch (error) {
      logger.warn(`failed to load ${file}: ${error}`);
    }
  }

  protected scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.items), "utf-8");
    } catch (error) {
      logger.warn(`failed to save ${this.file}: ${error}`);
    }
  }

  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.items), "utf-8");
    } catch (error) {
      logger.warn(`failed to save ${this.file}: ${error}`);
    }
  }
}

/**
 * 浏览历史：did-navigate / did-navigate-in-page 时追加，page-title-updated /
 * page-favicon-updated 回写同 url 最新条目的标题与图标。
 * 连续重复访问同一 url 只更新时间戳，避免刷新刷列表。
 */
export class HistoryStore extends JsonStore<HistoryEntry> {
  /** 最新在前。 */
  list(limit = 500): HistoryEntry[] {
    return this.items.slice(0, limit);
  }

  visit(entry: { url: string; title: string; favicon?: string }): void {
    if (!entry.url || entry.url === "about:blank" || entry.url.startsWith("devtools://")) {
      return;
    }
    const latest = this.items[0];
    if (latest && latest.url === entry.url) {
      latest.visitedAt = Date.now();
      if (entry.title) latest.title = entry.title;
      if (entry.favicon) latest.favicon = entry.favicon;
    } else {
      this.items.unshift({
        id: randomUUID(),
        url: entry.url,
        title: entry.title,
        favicon: entry.favicon,
        visitedAt: Date.now(),
      });
      if (this.items.length > HISTORY_LIMIT) this.items.length = HISTORY_LIMIT;
    }
    this.scheduleSave();
  }

  updateTitle(url: string, title: string): void {
    const entry = this.items.find((e) => e.url === url);
    if (entry && title && entry.title !== title) {
      entry.title = title;
      this.scheduleSave();
    }
  }

  updateFavicon(url: string, favicon: string): void {
    const entry = this.items.find((e) => e.url === url);
    if (entry && favicon && entry.favicon !== favicon) {
      entry.favicon = favicon;
      this.scheduleSave();
    }
  }

  remove(id: string): void {
    const index = this.items.findIndex((e) => e.id === id);
    if (index >= 0) {
      this.items.splice(index, 1);
      this.scheduleSave();
    }
  }

  clear(): void {
    this.items = [];
    this.scheduleSave();
  }
}

/** 收藏夹：扁平列表（v1 不做文件夹），按 url 去重。 */
export class BookmarkStore extends JsonStore<Bookmark> {
  list(): Bookmark[] {
    return this.items.slice();
  }

  findByUrl(url: string): Bookmark | undefined {
    return this.items.find((b) => b.url === url);
  }

  add(entry: { url: string; title: string; favicon?: string }): Bookmark | undefined {
    if (!entry.url || entry.url === "about:blank") return undefined;
    const existing = this.findByUrl(entry.url);
    if (existing) return existing;
    const bookmark: Bookmark = {
      id: randomUUID(),
      url: entry.url,
      title: entry.title || entry.url,
      favicon: entry.favicon,
      addedAt: Date.now(),
    };
    this.items.push(bookmark);
    this.scheduleSave();
    return bookmark;
  }

  remove(id: string): boolean {
    const index = this.items.findIndex((b) => b.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.scheduleSave();
    return true;
  }

  /** 有则删、无则加；返回切换后是否仍处于已收藏状态。 */
  toggle(entry: { url: string; title: string; favicon?: string }): boolean {
    const existing = this.findByUrl(entry.url);
    if (existing) {
      this.remove(existing.id);
      return false;
    }
    return this.add(entry) !== undefined;
  }
}
