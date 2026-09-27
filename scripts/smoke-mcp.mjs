import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { port, token } = JSON.parse(
  readFileSync("C:/Users/user/.browser-mcp/server.json", "utf8"),
);

const client = new Client({ name: "test-client", version: "0.0.1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
console.log("connected");

const { tools } = await client.listTools();
console.log("tools:", tools.length);
console.log(tools.map((t) => t.name).join(", "));

const call = (name, args = {}) =>
  client.callTool({ name, arguments: args }).then((r) => {
    const text = r.content
      ?.map((c) => (c.type === "text" ? c.text : `[${c.type}:${c.mimeType}]`))
      .join("\n");
    return (r.isError ? "ERR " : "") + String(text).slice(0, 400);
  });

console.log("\n-- navigate:", await call("browser_navigate", { url: "https://example.com" }));
await new Promise((r) => setTimeout(r, 500));
console.log("\n-- snapshot:", await call("browser_snapshot"));
console.log("\n-- dom_snapshot:", await call("browser_dom_snapshot"));
console.log("\n-- click e1:", await call("browser_click", { ref: "e1" }));
await new Promise((r) => setTimeout(r, 1500));
console.log("\n-- state:", await call("browser_get_state"));
const shot = await call("browser_take_screenshot");
console.log("\n-- screenshot:", shot);
console.log("\n-- fill test on iana (no input, expect ref_not_found):",
  await call("browser_fill", { ref: "e1", value: "x" }));
console.log("\n-- tabs:", await call("browser_tabs", { action: "list" }));
console.log("\n-- resize:", await call("browser_resize", { width: 800, height: 600 }));
console.log("\n-- viewport in snapshot rect? get_state:",
  await call("browser_get_state"));

await client.close();
console.log("\nDONE");
