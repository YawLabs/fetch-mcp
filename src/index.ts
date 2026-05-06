import { createRequire } from "node:module";
import { startServer } from "./server.js";

// Surface package version on `--version` / `version` so the post-publish
// smoke test in .github/workflows/release.yml can verify the published
// tarball without binding to a real MCP client. Must be handled BEFORE
// startServer() -- that call connects stdio and blocks forever.
const subcommand = process.argv[2];
if (subcommand === "--version" || subcommand === "version") {
  const require = createRequire(import.meta.url);
  const { version } = require("../package.json");
  console.log(version);
  process.exit(0);
}

startServer().catch((err) => {
  console.error("fetch-mcp error:", err);
  process.exit(1);
});
