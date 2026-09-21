import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequester, setHttpContext } from "./http.js";
import { ALLOW_PRIVATE_HOSTS_ENV, allowPrivateHostsWarning, parseAllowPrivateHostsSetting } from "./policy.js";
import { registerContentTools } from "./tools/content.js";
import { registerFeedTools } from "./tools/feed.js";
import { registerHttpTools } from "./tools/http.js";
import { registerLinksTools } from "./tools/links.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerReaderTools } from "./tools/reader.js";
import { registerRobotsTools } from "./tools/robots.js";
import { registerSitemapTools } from "./tools/sitemap.js";

// Inlined by the single-binary build (build-binary.mjs --define); the bare
// createRequire(import.meta.url) at module load would crash the binary
// (import.meta.url is empty in the CJS bundle). Falls back to package.json for
// the normal ESM/tsup build.
declare const __VERSION__: string;
const version =
  typeof __VERSION__ !== "undefined" ? __VERSION__ : createRequire(import.meta.url)("../package.json").version;

export interface FetchServerOptions {
  /**
   * Operator opt-in: may a tool call set `allow_private_hosts` to reach
   * loopback / private / link-local hosts? Default false -- such calls are
   * refused. `startServer()` sets it from FETCH_MCP_ALLOW_PRIVATE_HOSTS.
   *
   * Per server: each createFetchServer() call binds its own policy into the
   * requester its tools use, so servers in one process never share or
   * overwrite each other's setting.
   */
  allowPrivateHosts?: boolean;
}

export function createFetchServer(options: FetchServerOptions = {}): McpServer {
  setHttpContext({ version });
  const request = createRequester({ allowPrivateHosts: options.allowPrivateHosts === true });
  const server = new McpServer({ name: "fetch-mcp", version });
  registerHttpTools(server, request);
  registerContentTools(server, request);
  registerRobotsTools(server, request);
  registerSitemapTools(server, request);
  registerMetaTools(server, request);
  registerLinksTools(server, request);
  registerFeedTools(server, request);
  registerReaderTools(server, request);
  return server;
}

export async function startServer(): Promise<void> {
  const raw = process.env[ALLOW_PRIVATE_HOSTS_ENV];
  // stderr only: stdout is the MCP channel.
  const warning = allowPrivateHostsWarning(raw);
  if (warning) process.stderr.write(warning);
  const server = createFetchServer({ allowPrivateHosts: parseAllowPrivateHostsSetting(raw) === "on" });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
