import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Cookie, CookiesSetDetails, Session } from "electron";
import type { StringCipher } from "./credentials.js";
import { logger } from "./logger.js";

const FLUSH_DEBOUNCE_MS = 2_000;
const FLUSH_INTERVAL_MS = 5 * 60_000;

/**
 * 会话 Cookie 的可序列化子集。只快照 session cookie（无过期时间的登录态）：
 * 持久 cookie Chromium 本来就落盘在 partition 里；会话 cookie 退出即被清，
 * 这是"重启浏览器就掉登录"的根源。
 */
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  sameSite: string;
}

export function toRecord(cookie: Cookie): CookieRecord {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? "",
    path: cookie.path ?? "/",
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    hostOnly: !!cookie.hostOnly,
    sameSite: cookie.sameSite ?? "unspecified",
  };
}

export function toSetDetails(record: CookieRecord): CookiesSetDetails {
  const host = record.hostOnly ? record.domain : record.domain.replace(/^\./, "");
  return {
    url: `${record.secure ? "https" : "http"}://${host}${record.path || "/"}`,
    name: record.name,
    value: record.value,
    ...(record.hostOnly ? {} : { domain: record.domain }),
    path: record.path || "/",
    secure: record.secure,
    httpOnly: record.httpOnly,
    sameSite: record.sameSite as CookiesSetDetails["sameSite"],
  };
}

/** 全量快照当前 session cookie 到加密文件（含空表覆盖，清掉过期残留）。 */
async function snapshot(session: Session, file: string, cipher: StringCipher): Promise<number> {
  if (!cipher.isAvailable()) return 0;
  const records = (await session.cookies.get({}))
    .filter((cookie) => cookie.session)
    .map(toRecord);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, data: cipher.encrypt(JSON.stringify(records)) }));
  return records.length;
}

/** 启动时恢复上次快照；逐条容错，返回恢复条数。 */
export async function restoreSessionCookies(
  session: Session,
  file: string,
  cipher: StringCipher,
): Promise<number> {
  try {
    if (!existsSync(file) || !cipher.isAvailable()) return 0;
    const raw = JSON.parse(readFileSync(file, "utf-8")) as { v?: number; data?: string };
    if (raw?.v !== 1 || typeof raw.data !== "string") return 0;
    const records = JSON.parse(cipher.decrypt(raw.data)) as CookieRecord[];
    let restored = 0;
    for (const record of records) {
      try {
        // set 失败（非法属性等）会 reject，走 warn 跳过
        await session.cookies.set(toSetDetails(record));
        restored += 1;
      } catch (error) {
        logger.warn(`[cookies] restore ${record.domain}/${record.name} failed: ${error}`);
      }
    }
    if (restored) logger.info(`[cookies] restored ${restored} session cookie(s)`);
    return restored;
  } catch (error) {
    logger.warn(`[cookies] restore failed: ${error}`);
    return 0;
  }
}

/**
 * 会话 Cookie 守护：cookies changed 防抖 2s + 每 5 min 兜底全量快照。
 * 登录（写 session cookie）后 2s 即落盘，正常退出前基本无丢失窗口。
 */
export function startSessionCookieKeeper(
  session: Session,
  file: string,
  cipher: StringCipher,
): { flushNow(): Promise<number>; stop(): void } {
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => {
    void snapshot(session, file, cipher).catch((error) =>
      logger.warn(`[cookies] snapshot failed: ${error}`),
    );
  };
  const schedule = (): void => {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(run, FLUSH_DEBOUNCE_MS);
  };
  session.cookies.on("changed", schedule);
  const interval = setInterval(schedule, FLUSH_INTERVAL_MS);
  return {
    flushNow: () => snapshot(session, file, cipher),
    stop: () => {
      running = false;
      clearTimeout(timer);
      clearInterval(interval);
      session.cookies.removeListener("changed", schedule);
    },
  };
}
