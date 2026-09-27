// MCP session 生命周期回归（需 App 以 BROWSER_MCP_ORPHAN_GRACE_MS=1500 启动）：
// 1) session 断开（SSE abort，无 DELETE）→ 其分组 tab 变孤儿（orphanTabs），
//    分组保留、可被新 session claim/显式寻址接管。
// 2) 同名分组仍被存活 session 寻址时不算孤儿。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { port, token } = JSON.parse(
  readFileSync(join(homedir(), ".browser-mcp", "server.json"), "utf-8"),
);
const base = `http://127.0.0.1:${port}`;

const connect = async (name) => {
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
};
const call = (client, name, args = {}) =>
  client
    .callTool({ name, arguments: args })
    .then((r) => JSON.parse(r.content?.find((c) => c.type === "text")?.text ?? "{}"));
const tabs = async () =>
  (
    await (
      await fetch(`${base}/tabs`, { headers: { authorization: `Bearer ${token}` } })
    ).json()
  ).tabs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GRACE = 2500; // > App 侧 BROWSER_MCP_ORPHAN_GRACE_MS=1500

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " | " + extra : ""}`);
  if (!cond) failures += 1;
};

try {
  // ---- 场景 1：独占分组死亡 → 孤儿可认领 ----
  const a = await connect("life-a");
  const listed = await call(a, "browser_tabs", { action: "new", url: "https://example.com" });
  const tabA = listed.tabs?.[listed.tabs.length - 1]?.tabId;
  check("session A created grouped tab", !!tabA, `tabId=${tabA}`);

  await a.close(); // abort SSE，不发 DELETE
  await sleep(GRACE);

  const d = await connect("life-observer");
  let list = await call(d, "browser_tabs", { action: "list" });
  check(
    "dead session's tab listed as orphan",
    (list.orphanTabs ?? []).some((t) => t.id === tabA),
    `orphans=${(list.orphanTabs ?? []).map((t) => (t.id ?? "").slice(0, 8))}`,
  );
  let t = await tabs();
  check("orphan keeps its group chip", !!t.find((x) => x.tabId === tabA)?.group);

  const claim = await call(d, "browser_tabs", { action: "claim", tabId: tabA });
  check("orphan tab claimable by new session", claim.ok === true && claim.tab?.tabId === tabA,
    JSON.stringify(claim).slice(0, 160));

  // ---- 场景 2：共享分组（同 client + 同 group）死亡一方时仍有存活者 → 非孤儿 ----
  const SHARED = "shared-thread-x";
  const b = await connect("life-shared");
  const c = await connect("life-shared");
  const listedB = await call(b, "browser_tabs", {
    action: "new",
    url: "https://example.org",
    group: SHARED,
  });
  const tabB = listedB.tabs?.[listedB.tabs.length - 1]?.tabId;
  check("B created tab in shared group", !!tabB, `tabId=${tabB}`);
  const listC = await call(c, "browser_tabs", { action: "list", group: SHARED });
  check("C sees shared group tab as own", (listC.tabs ?? []).some((x) => x.tabId === tabB));

  await b.close();
  await sleep(GRACE);
  list = await call(d, "browser_tabs", { action: "list" });
  check(
    "shared group not orphan while C alive",
    !(list.orphanTabs ?? []).some((x) => x.id === tabB),
  );
  const stillC = await call(c, "browser_tabs", { action: "list", group: SHARED });
  check("C still owns shared tab", (stillC.tabs ?? []).some((x) => x.tabId === tabB));

  await c.close();
  await sleep(GRACE);
  list = await call(d, "browser_tabs", { action: "list" });
  check(
    "shared group orphaned after last session dead",
    (list.orphanTabs ?? []).some((x) => x.id === tabB),
  );

  await d.close();
} finally {
  // 清场：关掉本测试遗留的 tab
  const t = await tabs();
  for (const tab of t) {
    if (/example\.(com|org)/.test(tab.url ?? "")) {
      await fetch(`${base}/command`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          command: { method: "close", tabId: tab.tabId },
          client: "life-cleanup",
          group: "cleanup",
        }),
      });
    }
  }
}

console.log(failures === 0 ? "DONE OK" : `DONE ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
