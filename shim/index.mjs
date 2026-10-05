#!/usr/bin/env node
/**
 * browser-mcp stdio shim
 *
 * 给只支持 stdio 的 MCP client（OpenCode 等）用：
 *   - 读 ~/.browser-mcp/server.json 拿到 {port, token}
 *   - 可选：server.json 不存在/服务未响应时，用 BROWSER_MCP_APP_CMD 拉起桌面 App
 *   - 建立 StreamableHTTP MCP client 连接，并在 stdio 上代理 tools/list + tools/call
 *
 * 用法：node shim/index.mjs
 * 环境变量：
 *   BROWSER_MCP_APP_CMD   App 启动命令，如: "D:\\Browser MCP\\browser-mcp\\node_modules\\electron\\dist\\electron.exe" "D:\\Browser MCP\\browser-mcp"
 *   BROWSER_MCP_HOME      覆盖 discovery 目录（默认 ~/.browser-mcp）
 *   BROWSER_MCP_GROUP     固定本 shim 上游会话的 tab 分组（thread）名；
 *                         跨重连稳定分组时用（如 per-project 配置）
 *   BROWSER_MCP_CLIENT    覆盖上报给 App 的 client 名（默认透传下游 clientInfo.name）
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const log = (...args) => console.error("[browser-mcp-shim]", ...args);

const DISCOVERY_DIR = process.env.BROWSER_MCP_HOME ?? join(homedir(), ".browser-mcp");
const DISCOVERY_FILE = join(DISCOVERY_DIR, "server.json");
const CONNECT_RETRY_MS = 20_000;
const CONNECT_POLL_MS = 500;

function readDiscovery() {
  try {
    return JSON.parse(readFileSync(DISCOVERY_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthy(port, pid) {
  if (pid && !isPidAlive(pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function maybeLaunchApp() {
  const cmd = process.env.BROWSER_MCP_APP_CMD;
  if (!cmd) return false;
  const mtime = existsSync(DISCOVERY_FILE) ? statSync(DISCOVERY_FILE).mtimeMs : 0;
  const stale = Date.now() - mtime > 60_000;
  log(`launching app via BROWSER_MCP_APP_CMD (discovery ${stale ? "stale" : "missing"})`);
  // 若已有 discovery 文件但 PID 已死，清理掉避免新 App 启动期间 shim 继续读到旧端口
  if (existsSync(DISCOVERY_FILE)) {
    try {
      const d = JSON.parse(readFileSync(DISCOVERY_FILE, "utf8"));
      if (d.pid && !isPidAlive(d.pid)) {
        log("discovery points to a dead pid; removing stale server.json");
        rmSync(DISCOVERY_FILE);
      }
    } catch {
      // ignore malformed discovery
    }
  }
  const env = { ...process.env };
  // Windows 上 ELECTRON_RUN_AS_NODE="" 仍会被 Electron 视为已设置（run-as-node），必须删除
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(cmd, {
    shell: true,
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  return true;
}

async function connectUpstream(clientName) {
  const deadline = Date.now() + CONNECT_RETRY_MS;
  let launched = false;
  let lastError;
  for (;;) {
    const discovery = readDiscovery();
    if (discovery && (await healthy(discovery.port, discovery.pid))) {
      const headers = { authorization: `Bearer ${discovery.token}` };
      const group = process.env.BROWSER_MCP_GROUP?.trim();
      if (group) headers["x-bmcp-group"] = group;
      const client = new Client({ name: clientName, version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${discovery.port}/mcp`),
        { requestInit: { headers } },
      );
      try {
        await client.connect(transport);
        log(`connected to http://127.0.0.1:${discovery.port}/mcp as "${clientName}"`);
        return client;
      } catch (error) {
        lastError = error;
      }
    }
    if (!launched && maybeLaunchApp()) launched = true;
    if (Date.now() >= deadline) {
      throw lastError ?? new Error("browser-mcp app is not running and BROWSER_MCP_APP_CMD is unset");
    }
    await new Promise((r) => setTimeout(r, CONNECT_POLL_MS));
  }
}

const server = new Server(
  { name: "browser-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// 上游延迟到第一个请求再连：那时下游已完成 initialize，
// server.getClientVersion() 能拿到真实 agent 软件名（opencode 等），
// 用作 tab 分组的 client 维度。
let upstreamPromise;
function upstream() {
  if (!upstreamPromise) {
    const downstream = server.getClientVersion()?.name;
    const name = process.env.BROWSER_MCP_CLIENT?.trim() || downstream || "browser-mcp-shim";
    upstreamPromise = connectUpstream(name);
    upstreamPromise.then(
      (client) => {
        client.onerror = (error) => log("upstream error:", error);
        client.onclose = () => {
          // 上游会话断开（App 重启 / session idle TTL）不退出：
          // 清掉缓存的 client，下个请求时重连（必要时重新拉起 App）
          log("upstream closed; will reconnect on next request");
          upstreamPromise = undefined;
        };
      },
      () => {},
    );
  }
  return upstreamPromise;
}

server.setRequestHandler(ListToolsRequestSchema, async () =>
  (await upstream()).listTools(),
);
server.setRequestHandler(CallToolRequestSchema, async (req) =>
  (await upstream()).callTool(req.params),
);

server.onerror = (error) => log("server error:", error);

await server.connect(new StdioServerTransport());
log("stdio proxy ready");
