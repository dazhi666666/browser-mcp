import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["D:/Browser MCP/browser-mcp/shim/index.mjs"],
});
const client = new Client({ name: "shim-test", version: "0.0.1" });
await client.connect(transport);
console.log("shim connected");
const { tools } = await client.listTools();
console.log("tools via stdio:", tools.length);
const r = await client.callTool({ name: "browser_get_state", arguments: {} });
console.log("callTool:", JSON.stringify(r.content).slice(0, 300));
await client.close();
console.log("DONE");
process.exit(0);
