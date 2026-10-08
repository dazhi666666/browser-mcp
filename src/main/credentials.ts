import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import electron from "electron";
import type { WebContents } from "electron";
import { logger } from "./logger.js";

/** 磁盘加密抽象：生产用 Electron safeStorage（Windows 走 DPAPI），测试可注入桩实现。 */
export interface StringCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(blob: string): string;
}

export function safeStorageCipher(): StringCipher {
  const { safeStorage } = electron;
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, "base64")),
  };
}

export interface StoredCredential {
  id: string;
  /** 形如 https://example.com 的 origin。 */
  origin: string;
  username: string;
  password: string;
  /** 捕获时的用户名字段标识（name/id），仅作展示/调试线索。 */
  usernameField?: string;
  createdAt: number;
  lastUsedAt: number;
}

/** 从 URL 或裸主机名提取 http(s) origin；非法输入返回 undefined。 */
export function originOf(input: string): string | undefined {
  if (!input) return undefined;
  for (const candidate of [input, `https://${input}`]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // 尝试下一个候选形式
    }
  }
  return undefined;
}

const SAVE_DEBOUNCE_MS = 500;
/** dom-ready 时页面可能还没渲染出登录表单（SPA），未命中按此节奏补试。 */
const AUTOFILL_RETRY_DELAYS_MS = [1_500, 4_000];

/**
 * 登录凭据存储：Electron 没有 Chrome 的密码管理器，登录表单提交时由 guest preload
 * 捕获（见 guestPreload.cts）后存到这里。整表经 safeStorage 加密后落盘
 * （{ v:1, data: <base64> }）；加密不可用时只在内存里保留、不落盘。
 */
export class CredentialStore {
  private items: StoredCredential[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(private file: string, private cipher: StringCipher) {
    try {
      if (existsSync(file) && cipher.isAvailable()) {
        const raw = JSON.parse(readFileSync(file, "utf-8")) as { v?: number; data?: string };
        if (raw?.v === 1 && typeof raw.data === "string") {
          this.items = JSON.parse(cipher.decrypt(raw.data)) as StoredCredential[];
        }
      }
    } catch (error) {
      logger.warn(`failed to load ${file}: ${error}`);
      this.items = [];
    }
  }

  /** 列表视图（绝不含密码）。 */
  list(): Array<Omit<StoredCredential, "password">> {
    return this.items.map(({ password: _password, ...rest }) => rest);
  }

  /** 按 origin+username 去重 upsert；返回保存后的完整条目。 */
  save(entry: {
    origin: string;
    username: string;
    password: string;
    usernameField?: string;
  }): StoredCredential {
    const existing = this.items.find(
      (c) => c.origin === entry.origin && c.username === entry.username,
    );
    if (existing) {
      existing.password = entry.password;
      existing.usernameField = entry.usernameField;
      existing.lastUsedAt = Date.now();
      this.scheduleSave();
      return existing;
    }
    const created: StoredCredential = {
      id: randomUUID(),
      origin: entry.origin,
      username: entry.username,
      password: entry.password,
      ...(entry.usernameField ? { usernameField: entry.usernameField } : {}),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.items.push(created);
    this.scheduleSave();
    return created;
  }

  remove(id: string): boolean {
    const index = this.items.findIndex((c) => c.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.scheduleSave();
    return true;
  }

  /** 该 origin 最近使用的凭据（回填用）。 */
  findForOrigin(origin: string): StoredCredential | undefined {
    return this.items
      .filter((c) => c.origin === origin)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
  }

  /** dom-ready 回填入口：命中 origin 且页面有空密码框才注入；只填空字段，不覆盖已输入。 */
  autofill(wc: WebContents): void {
    const origin = originOf(wc.getURL());
    const credential = origin ? this.findForOrigin(origin) : undefined;
    if (!credential) return;
    void this.attemptAutofill(wc, credential, 0);
  }

  private async attemptAutofill(
    wc: WebContents,
    credential: StoredCredential,
    attempt: number,
  ): Promise<void> {
    if (wc.isDestroyed()) return;
    try {
      const result = (await wc.executeJavaScript(
        buildAutofillScript(credential.username, credential.password),
      )) as { filled?: boolean } | undefined;
      if (result?.filled) {
        credential.lastUsedAt = Date.now();
        this.scheduleSave();
        logger.info(`[credentials] autofilled ${credential.origin}`);
        return;
      }
    } catch {
      // executeJavaScript 随导航失败：走补试/放弃
    }
    if (
      attempt < AUTOFILL_RETRY_DELAYS_MS.length &&
      !wc.isDestroyed() &&
      originOf(wc.getURL()) === credential.origin
    ) {
      setTimeout(
        () => void this.attemptAutofill(wc, credential, attempt + 1),
        AUTOFILL_RETRY_DELAYS_MS[attempt],
      );
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flushSync();
    }, SAVE_DEBOUNCE_MS);
  }

  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      if (!this.cipher.isAvailable()) {
        logger.warn("[credentials] encryption unavailable; keeping credentials in memory only");
        this.dirty = true; // 加密恢复后仍需落盘
        return;
      }
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        JSON.stringify({ v: 1, data: this.cipher.encrypt(JSON.stringify(this.items)) }),
      );
    } catch (error) {
      logger.warn(`failed to save ${this.file}: ${error}`);
    }
  }
}

/**
 * 页内回填脚本（main world 注入，模式同新标签页磁贴注入）：
 * 第一个空的可见密码框 + 它之前最近的空文本框；原生 setter 派发 input/change 以兼容 React。
 * 只回填空字段（不覆盖用户输入），返回值不含任何凭据内容。
 */
export function buildAutofillScript(username: string, password: string): string {
  return (
    "(function(){" +
    "try{" +
    "var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;" +
    "var fill=function(i,v){set.call(i,v);i.dispatchEvent(new Event('input',{bubbles:true}));" +
    "i.dispatchEvent(new Event('change',{bubbles:true}));};" +
    "var usable=function(i){return !i.disabled&&!i.readOnly&&!i.value&&i.offsetParent!==null;};" +
    "var pw=[].slice.call(document.querySelectorAll('input[type=password]')).filter(usable)[0];" +
    "if(!pw)return{filled:false};" +
    "var scope=pw.form||document;" +
    "var texts=[].slice.call(" +
    "scope.querySelectorAll('input[type=text],input[type=email],input[type=tel],input:not([type])'))" +
    ".filter(function(i){return i.type!=='hidden'&&usable(i);});" +
    "var before=texts.filter(function(i){return pw.compareDocumentPosition(i)&2;});" +
    "var un=before.length?before[before.length-1]:(texts[0]||null);" +
    "if(un)fill(un," + JSON.stringify(username) + ");" +
    "fill(pw," + JSON.stringify(password) + ");" +
    "return{filled:true,username:!!un};" +
    "}catch(e){return{filled:false,error:String(e)};}" +
    "})();"
  );
}
