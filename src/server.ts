import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setHttpContext } from "./http.js";
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
   * Process-wide: the policy lives in the http module's context, so the most
   * recent createFetchServer() call decides for every server in the process.
   * The stdio server creates exactly one; an embedder creating several must
   * give them all the same setting.
   */
  allowPrivateHosts?: boolean;
}

export function createFetchServer(options: FetchServerOptions = {}): McpServer {
  setHttpContext({ version, allowPrivateHosts: options.allowPrivateHosts === true });
  const server = new McpServer({ name: "fetch-mcp", version });
  registerHttpTools(server);
  registerContentTools(server);
  registerRobotsTools(server);
  registerSitemapTools(server);
  registerMetaTools(server);
  registerLinksTools(server);
  registerFeedTools(server);
  registerReaderTools(server);
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
