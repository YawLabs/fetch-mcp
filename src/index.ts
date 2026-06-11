import { createRequire } from "node:module";
import { startServer } from "./server.js";

// Inlined by the single-binary build (build-binary.mjs --define); undefined
// in the normal ESM/tsup build.
declare const __VERSION__: string;

// Surface package version on `--version` / `version` so the post-publish
// smoke test in .github/workflows/release.yml can verify the published
// tarball without binding to a real MCP client. Must be handled BEFORE
// startServer() -- that call connects stdio and blocks forever.
const subcommand = process.argv[2];
if (subcommand === "--version" || subcommand === "version") {
  const version =
    typeof __VERSION__ !== "undefined" ? __VERSION__ : createRequire(import.meta.url)("../package.json").version;
  console.log(version);
  process.exit(0);
}

startServer().catch((err) => {
  console.error("fetch-mcp error:", err);
  process.exit(1);
});
