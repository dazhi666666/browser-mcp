// 端到端验证：登录表单捕获 → 加密落盘 → 同源回填 → 会话 Cookie 跨重启保留。
//   node scripts/smoke-credentials.mjs pre   # 登录 + 捕获 + 回填 + cookie 快照
//   node scripts/smoke-credentials.mjs post  # 重启后：免登录仍已登录 + 凭据/回填仍在 + 清理
import { readFileSync, existsSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 18499; // 固定端口：pre/post 两次运行 origin 必须一致
const ORIGIN = `http://127.0.0.1:${PORT}`;
const USER = "agent01";
const PASS = "s3cret-pw-2026";
const CRED_FILE = `${homedir().replace(/\\/g, "/")}/.browser-mcp/credentials.json`;
const COOKIE_FILE = `${homedir().replace(/\\/g, "/")}/.browser-mcp/session-cookies.json`;
const phase = process.argv[2];

let failures = 0;
const check = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 本地登录站点：POST /login 设无过期时间的 session cookie（重启后浏览器默认会丢） ——
const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const cookies = Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf("=");
        return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
      }),
  );
  if (url.pathname === "/login" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(
      `<!doctype html><html><head><title>login</title></head><body>
       <form method="POST" action="/login">
         <input name="user" placeholder="username">
         <input type="password" name="pw" placeholder="password">
         <button type="submit">sign in</button>
       </form></body></html>`,
    );
  }
  if (url.pathname === "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const p = new URLSearchParams(body);
      if (p.get("user") === USER && p.get("pw") === PASS) {
        res.writeHead(302, {
          "set-cookie": `sid=s-${Date.now()}; Path=/; HttpOnly`,
          location: "/",
        });
        return res.end();
      }
      res.writeHead(302, { location: "/login?bad=1" });
      res.end();
    });
  }
  if (url.pathname === "/") {
    if (cookies.sid && cookies.sid.startsWith("s-")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<html><body>OK logged in as ${USER}</body></html>`);
    }
    res.writeHead(302, { location: "/login" });
    return res.end();
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`test site on ${ORIGIN}`);

const { port, token } = JSON.parse(readFileSync("C:/Users/user/.browser-mcp/server.json", "utf8"));
const client = new Client({ name: "verify-credentials", version: "0.0.1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
const call = (name, args = {}) =>
  client.callTool({ name, arguments: args }).then((r) => {
    const text = r.content?.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    try {
      return { err: r.isError === true, data: JSON.parse(text) };
    } catch {
      return { err: r.isError === true, text: String(text).slice(0, 300) };
    }
  });
const evalJs = async (expression) => (await call("browser_evaluate", { expression })).data?.value;

try {
  if (phase === "pre") {
    // 1. 真实表单提交登录（submit 事件 → preload 捕获 → 主进程保存）
    await call("browser_navigate", { url: `${ORIGIN}/login` });
    await sleep(500);
    await evalJs(`(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const user = document.querySelector('input[name=user]');
      const pw = document.querySelector('input[type=password]');
      set.call(user, ${JSON.stringify(USER)}); user.dispatchEvent(new Event('input', {bubbles:true}));
      set.call(pw, ${JSON.stringify(PASS)}); pw.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('button[type=submit]').click();
      return 'submitted';
    })()`);
    await sleep(1200);

    const page = await evalJs(`document.body ? document.body.textContent : ''`);
    check(String(page).includes("OK logged in as"), "登录成功（session cookie 已设置）");

    // 2. 凭据已捕获：list 有条目、无密码明文
    const list = await call("browser_credentials", { action: "list" });
    const entries = list.data?.credentials ?? [];
    const entry = entries.find((e) => e.origin === ORIGIN);
    check(!!entry, "凭据已捕获（browser_credentials list）", JSON.stringify(entry ?? entries));
    check(!JSON.stringify(list.data).includes(PASS), "list 结果不含密码明文");

    // 3. 磁盘加密：文件存在且不含明文密码/用户名
    await sleep(800); // 保存防抖 500ms
    check(existsSync(CRED_FILE), "credentials.json 已落盘");
    const raw = existsSync(CRED_FILE) ? readFileSync(CRED_FILE, "utf8") : "";
    check(!!raw && !raw.includes(PASS) && !raw.includes(USER), "落盘内容已加密（无明文密码/用户名）");

    // 4. 会话 Cookie 快照：changed 防抖 2s 后落盘，且不含明文
    await sleep(2500);
    check(existsSync(COOKIE_FILE), "session-cookies.json 已落盘");
    const rawCookie = existsSync(COOKIE_FILE) ? readFileSync(COOKIE_FILE, "utf8") : "";
    check(!!rawCookie && !rawCookie.includes("sid="), "cookie 快照已加密（无明文 sid）");

    // 5. 回填：重新打开登录页，字段应自动填充
    await call("browser_navigate", { url: `${ORIGIN}/login` });
    await sleep(5500); // dom-ready + 重试节奏(1.5s/4s)
    const filled = await evalJs(`(() => {
      const pw = document.querySelector('input[type=password]');
      return { u: document.querySelector('input[name=user]').value,
               p: pw ? pw.value.slice(0, 5) : '', plen: pw ? pw.value.length : 0 };
    })()`);
    check(
      filled?.u === USER && filled?.p === PASS.slice(0, 5) && filled?.plen === PASS.length,
      "重新打开登录页已自动回填",
      JSON.stringify(filled),
    );
  } else if (phase === "post") {
    // 6. 重启后免登录：session cookie 从快照恢复
    await call("browser_navigate", { url: `${ORIGIN}/` });
    await sleep(800);
    const page = await evalJs(`document.body ? document.body.textContent : ''`);
    check(String(page).includes("OK logged in as"), "重启后免登录（session cookie 已恢复）", String(page).slice(0, 80));

    // 7. 凭据仍在且回填仍生效
    const list = await call("browser_credentials", { action: "list" });
    const entry = (list.data?.credentials ?? []).find((e) => e.origin === ORIGIN);
    check(!!entry, "重启后凭据仍在", JSON.stringify(entry ?? list.data).slice(0, 120));

    await call("browser_navigate", { url: `${ORIGIN}/login` });
    await sleep(5500);
    const filled = await evalJs(`(() => {
      const pw = document.querySelector('input[type=password]');
      return { u: document.querySelector('input[name=user]').value,
               p: pw ? pw.value.slice(0, 5) : '' };
    })()`);
    check(filled?.u === USER && filled?.p === PASS.slice(0, 5), "重启后回填仍生效", JSON.stringify(filled));

    // 8. 清理测试凭据
    if (entry) {
      const del = await call("browser_credentials", { action: "delete", id: entry.id });
      check(del.data?.removed === true, "清理测试凭据");
    }
  } else {
    console.log("usage: node scripts/smoke-credentials.mjs pre|post");
    process.exitCode = 2;
  }
} finally {
  await client.close().catch(() => {});
  server.close();
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
