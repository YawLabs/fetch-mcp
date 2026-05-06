import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const DIST_BIN = resolve(REPO_ROOT, "dist", "index.js");
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")).version;

// The --version handler must be in dist/index.js (the published bin entry)
// AND must run BEFORE startServer() -- the latter connects stdio and blocks
// forever, so a --version invocation that reaches it would hang. The smoke
// test step in .github/workflows/release.yml depends on this contract.
describe("--version subcommand", () => {
  // dist/ is built by `npm test` (via test:ci) or `npm run build`; tolerate
  // a developer running `vitest` directly without a build by skipping
  // rather than failing -- CI always runs the build step first.
  const buildAvailable = existsSync(DIST_BIN);

  it.skipIf(!buildAvailable)("'--version' prints the package.json version and exits 0", () => {
    const stdout = execFileSync(process.execPath, [DIST_BIN, "--version"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    expect(stdout.trim()).toBe(PACKAGE_VERSION);
  });

  it.skipIf(!buildAvailable)("'version' (without dashes) is also accepted", () => {
    const stdout = execFileSync(process.execPath, [DIST_BIN, "version"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    expect(stdout.trim()).toBe(PACKAGE_VERSION);
  });
});
