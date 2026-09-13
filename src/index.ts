import { createRequire } from "node:module";
import { startServer } from "./server.js";

// Inlined by the single-binary build (build-binary.mjs --define); undefined
// in the normal ESM/tsup build.
declare const __VERSION__: string;

// Surface package version on `--version` / `version` so the post-publish
// smoke test in release.sh (step 7) can verify the published
// tarball without binding to a real MCP client. Must be handled BEFORE
// startServer() -- that call connects stdio and blocks forever.
const subcommand = process.argv[2];
if (subcommand === "--version" || subcommand === "version") {
  const version =
    typeof __VERSION__ !== "undefined" ? __VERSION__ : createRequire(import.meta.url)("../package.json").version;
  console.log(version);
  process.exit(0);
}

// Reject any other argument instead of falling through to startServer(). A
// typo (`fetch-mcp versoin`) or an unsupported flag (`--help`) used to print
// nothing and block on stdin forever, which reads as "the package is broken".
// The server starts only when no argument is given -- the way MCP hosts launch
// it, and the way every bin/fetch-mcp.mjs path arrives: its in-process import
// keeps the launcher's own (empty) argv, and its `oam run <entry> -- ...` spawn
// reaches here with none because oam consumes the `--` separator. stderr, never
// stdout: stdout is the MCP channel.
if (subcommand !== undefined) {
  console.error(
    `Unknown subcommand: ${subcommand}\nUsage: fetch-mcp [version|--version]  (no argument starts the stdio MCP server)`,
  );
  process.exit(1);
}

startServer().catch((err) => {
  console.error("fetch-mcp error:", err);
  process.exit(1);
});
