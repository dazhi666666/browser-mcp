// 通过运行中 app 的 /command 截图生成多尺寸 icon PNG，再封装 icon.ico
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const info = JSON.parse(
  readFileSync("C:/Users/user/.browser-mcp/server.json", "utf-8"),
);
const BASE = `http://127.0.0.1:${info.port}`;
const AUTH = { Authorization: `Bearer ${info.token}` };
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function command(cmd) {
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ command: cmd }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${cmd.method} failed: ${JSON.stringify(json.error)}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// file:// 被 navigation_blocked 拦截，起一个临时 http server 服务 icon.html
const iconHtml = readFileSync("assets/icon.html", "utf-8");
const staticServer = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(iconHtml);
});
await new Promise((r) => staticServer.listen(0, "127.0.0.1", r));
const iconBase = `http://127.0.0.1:${staticServer.address().port}/icon.html`;
console.log("serving icon at", iconBase);

const { tabId } = await (
  await fetch(`${BASE}/tabs`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ url: `${iconBase}?256` }),
  })
).json();
console.log("tab:", tabId);
await sleep(800);

const entries = [];
for (const size of SIZES.slice().reverse()) {
  await command({
    method: "navigate",
    tabId,
    url: `${iconBase}?${size}`,
  });
  await sleep(400);
  const shot = await command({
    method: "screenshot",
    tabId,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  const png = Buffer.from(shot.image.base64, "base64");
  writeFileSync(`assets/icon-${size}.png`, png);
  entries.push({ size, png });
  console.log(`captured ${size}x${size} ${png.length}B`);
}
entries.sort((a, b) => a.size - b.size);

// ICO 封装（PNG 内嵌式）
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
const dirs = Buffer.alloc(16 * entries.length);
let offset = 6 + dirs.length;
entries.forEach(({ size, png }, i) => {
  const o = 16 * i;
  dirs.writeUInt8(size >= 256 ? 0 : size, o);
  dirs.writeUInt8(size >= 256 ? 0 : size, o + 1);
  dirs.writeUInt16LE(1, o + 4);
  dirs.writeUInt16LE(32, o + 6);
  dirs.writeUInt32LE(png.length, o + 8);
  dirs.writeUInt32LE(offset, o + 12);
  offset += png.length;
});
writeFileSync("assets/icon.ico", Buffer.concat([header, dirs, ...entries.map((e) => e.png)]));
console.log("wrote assets/icon.ico");

await command({ method: "browserViewportReset", tabId }).catch(() => {});
await fetch(`${BASE}/tabs/close`, {
  method: "POST",
  headers: { ...AUTH, "content-type": "application/json" },
  body: JSON.stringify({ tabId }),
});
staticServer.close();
console.log("done");
