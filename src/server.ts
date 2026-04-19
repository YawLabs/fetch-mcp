import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setHttpContext } from "./http.js";
import { registerContentTools } from "./tools/content.js";
import { registerHttpTools } from "./tools/http.js";
import { registerRobotsTools } from "./tools/robots.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

export function createFetchServer(): McpServer {
  setHttpContext({ version });
  const server = new McpServer({ name: "fetch-mcp", version });
  registerHttpTools(server);
  registerContentTools(server);
  registerRobotsTools(server);
  return server;
}

export async function startServer(): Promise<void> {
  const server = createFetchServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
