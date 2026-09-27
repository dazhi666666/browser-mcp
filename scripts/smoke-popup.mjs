// target=_blank / window.open 回归：popup 应改建为本窗口内的 tab，
// 继承来源 tab 的分组；background-tab disposition 不抢焦点。
// navigate 只允许 http/https，故测试页由内置 http server 提供。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { port, token } = JSON.parse(
  readFileSync(join(homedir(), ".browser-mcp", "server.json"), "utf-8"),
);
const cmd = async (command, group = "popup-thread") => {
  const res = await fetch(`http://127.0.0.1:${port}/command`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ command, group, client: "debug" }),
  });
  return res.json();
};
const tabs = async () =>
  (
    await (
      await fetch(`http://127.0.0.1:${port}/tabs`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()
  ).tabs;

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " | " + extra : ""}`);
  if (!cond) failures += 1;
};

// 本地测试页：一个 target=_blank 链接 + 一个 window.open 链接
const fixture = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  if (u.pathname === "/") {
    res.setHeader("content-type", "text/html");
    return res.end(
      '<!doctype html><title>popup source</title>' +
        '<a id="l" target="_blank" href="/target">open in blank</a>' +
        `<a id="w" href="javascript:void(window.open('/pop'))">win.open</a>`,
    );
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>${u.pathname.slice(1) || "t"}</title><h1>${u.pathname}</h1>`);
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const fport = fixture.address().port;
const base = `http://127.0.0.1:${fport}`;

try {
  console.log("-- navigate to test page (group popup-thread)");
  const nav = await cmd({ method: "navigate", url: base + "/" });
  check("navigate", nav.ok === true, JSON.stringify(nav).slice(0, 160));
  await new Promise((r) => setTimeout(r, 400));

  const snap = await cmd({ method: "snapshot" });
  const ref = (snap.snapshot?.elements ?? []).find((e) =>
    /open in blank/.test(e.name ?? ""),
  )?.ref;
  check("snapshot found target=_blank link", !!ref);

  const before = (await tabs()).length;
  console.log("-- click target=_blank link");
  const click = await cmd({ method: "click", ref });
  check("click ok", click.ok === true, JSON.stringify(click).slice(0, 160));
  await new Promise((r) => setTimeout(r, 1500));

  let list = await tabs();
  check(
    "new tab created in-window (no bare BrowserWindow)",
    list.length === before + 1,
    `count=${list.length}`,
  );
  const popup = list.find((t) => t.url.includes(`127.0.0.1:${fport}/target`));
  check("popup tab loaded target page", !!popup, popup?.url);
  check("popup tab active (foreground-tab)", popup?.active === true);
  const srcTab = list.find(
    (t) => t.url.endsWith("/") && t.url.includes(`${fport}`),
  );
  check(
    "popup inherited group",
    !!popup?.group && popup.group.id === srcTab?.group?.id,
    `${popup?.group?.label} vs ${srcTab?.group?.label}`,
  );

  console.log("-- getState resolves to popup (lastTabByScope)");
  const state = await cmd({ method: "getState" });
  check(
    "scope's active tab is the popup",
    (state?.state?.url ?? "").includes("/target"),
    JSON.stringify(state?.state?.url),
  );

  console.log("-- window.open() also becomes a tab");
  // 先回到源页面再 snapshot 拿 window.open 链接的 ref
  if (srcTab) await cmd({ method: "activateTab", tabId: srcTab.tabId });
  const snap2 = await cmd({ method: "snapshot" });
  const ref2 = (snap2.snapshot?.elements ?? []).find((e) => /win\.open/.test(e.name ?? ""))?.ref;
  if (ref2) {
    await cmd({ method: "click", ref: ref2 });
    await new Promise((r) => setTimeout(r, 1200));
    list = await tabs();
    const pop2 = list.find((t) => t.url.includes("/pop"));
    check("window.open popup became a tab", !!pop2, pop2?.url);
  } else {
    console.log("SKIP window.open test (ref not found on source snapshot)");
  }
} finally {
  fixture.close();
}

console.log(failures ? `FAILURES=${failures}` : "DONE OK");
process.exit(failures ? 1 : 0);
