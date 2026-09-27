// 双 MCP session 分组隔离测试：两个不同 client 名，各建 tab，验证 scope 隔离/claim/不可见性。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { port, token } = JSON.parse(
  readFileSync(join(homedir(), ".browser-mcp", "server.json"), "utf8"),
);
const base = `http://127.0.0.1:${port}`;

async function session(name, group) {
  const headers = { authorization: `Bearer ${token}` };
  if (group) headers["x-bmcp-group"] = group;
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers },
    }),
  );
  const call = (tool, args = {}) =>
    client.callTool({ name: tool, arguments: args }).then((r) => {
      const text = r.content?.find((c) => c.type === "text")?.text ?? "";
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    });
  return { client, call };
}

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};

// 会话 A：opencode，无固定组（thread=sessionId）；会话 B：claude-code，x-bmcp-group=t2
const A = await session("opencode");
const B = await session("claude-code", "t2");

// A 命名分组并建两个 tab
console.log("A scope:", JSON.stringify(await A.call("browser_scope", { action: "set", name: "调研线程" })));
await A.call("browser_tabs", { action: "new", url: "https://example.com" });
await A.call("browser_tabs", { action: "new", url: "https://www.iana.org" });

// B 建一个 tab
await B.call("browser_tabs", { action: "new", url: "https://example.org" });

const listA = await A.call("browser_tabs", { action: "list" });
const listB = await B.call("browser_tabs", { action: "list" });
console.log("A sees tabs:", listA.tabs?.length, "userTabs:", listA.userTabs?.length);
console.log("B sees tabs:", listB.tabs?.length, "userTabs:", listB.userTabs?.length);

if (listA.tabs?.length !== 2) fail(`A should see 2 own tabs, got ${listA.tabs?.length}`);
if (listB.tabs?.length !== 1) fail(`B should see 1 own tab, got ${listB.tabs?.length}`);

// A 不能用显式 tabId 碰 B 的 tab
const bTabId = listB.tabs?.[0]?.tabId;
const steal = await A.call("browser_get_state", { tabId: bTabId });
console.log("A->B explicit access:", JSON.stringify(steal).slice(0, 160));
if (!String(JSON.stringify(steal)).includes("another group")) {
  fail("A should be denied access to B's tab");
}

// B 也不能碰 A 的
const aTabId = listA.tabs?.[0]?.tabId;
const stealB = await B.call("browser_snapshot", { tabId: aTabId, maxElements: 5 });
if (!String(JSON.stringify(stealB)).includes("another group")) {
  fail("B should be denied access to A's tab");
}

// user tab：通过 /command debug scope 隐式 claim 一个 UI tab（先建一个无组 tab）
const res = await fetch(`${base}/command`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ command: { method: "newTab" }, group: "debugger-thread" }),
});
const dbg = await res.json();
console.log("debug newTab group check:", res.ok);

// A 的 list 里 userTabs 应含启动时 UI 建的 tab + debug 刚建的（debug 也是 agent 组！）
// debug scope 建的 tab 属于 debug 组 → A 的 userTabs 只含真正无组 tab
const listA2 = await A.call("browser_tabs", { action: "list" });
console.log(
  "A userTabs:",
  listA2.userTabs?.map((t) => t.id.slice(0, 8)),
);
const claimable = listA2.userTabs?.find((t) => t.url !== "");
if (claimable) {
  // A 用显式 tabId 隐式 claim 一个 user tab
  const claim = await A.call("browser_get_state", { tabId: claimable.id });
  console.log("implicit claim:", claim.ok !== false ? "ok" : claim);
  const listA3 = await A.call("browser_tabs", { action: "list" });
  if (listA3.tabs?.length !== 3) fail(`A should now own 3 tabs, got ${listA3.tabs?.length}`);
  else console.log("A now owns", listA3.tabs.length, "tabs after implicit claim");
}

// /tabs 全量视图（UI 用）：应看到 3 个分组
const tabs = await (await fetch(`${base}/tabs`, { headers: { authorization: `Bearer ${token}` } })).json();
const groups = {};
for (const t of tabs.tabs ?? []) {
  const g = t.group?.label ?? "(user)";
  groups[g] = (groups[g] ?? 0) + 1;
}
console.log("all tabs by group:", JSON.stringify(groups));

await A.client.close();
await B.client.close();
console.log("DONE", process.exitCode === 1 ? "WITH FAILURES" : "OK");
process.exit(0);
