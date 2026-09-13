import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const DIST_BIN = resolve(REPO_ROOT, "dist", "index.js");
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")).version;

// dist/ is built by `npm run test:ci` or `npm run build`; tolerate a developer
// running `vitest` directly without a build by skipping rather than failing --
// release.sh always builds before it tests.
const buildAvailable = existsSync(DIST_BIN);

// Matches vitest.config.ts's testTimeout. These bound a spawn that is
// expected to SUCCEED, so the ceiling must cover a real `node` start under
// load, not just a warm one: on a contended Windows box a bare `node -e "0"`
// was measured at ~11s, which alone blows a 5s ceiling and fails the test for
// machine load rather than for anything about the code.
//
// This is the ONLY bound on the synchronous spawns below: vitest's testTimeout
// cannot interrupt a blocked event loop, it only reports the overrun after the
// call returns. A regression that reaches startServer() does not hang here
// anyway -- execFileSync/spawnSync close the child's stdin, so the server exits
// 0 with no output, and the stdout/status assertions are what catch it.
const SPAWN_TIMEOUT_MS = 15_000;

// The --version handler must be in dist/index.js (the published bin entry)
// AND must run BEFORE startServer() -- the latter connects stdio and blocks
// forever, so a --version invocation that reaches it would hang. The
// post-publish smoke test in release.sh (step 7) depends on this contract.
describe("--version subcommand", () => {
  it.skipIf(!buildAvailable)("'--version' prints the package.json version and exits 0", () => {
    const stdout = execFileSync(process.execPath, [DIST_BIN, "--version"], {
      encoding: "utf-8",
      timeout: SPAWN_TIMEOUT_MS,
    });
    expect(stdout.trim()).toBe(PACKAGE_VERSION);
  });

  it.skipIf(!buildAvailable)("'version' (without dashes) is also accepted", () => {
    const stdout = execFileSync(process.execPath, [DIST_BIN, "version"], {
      encoding: "utf-8",
      timeout: SPAWN_TIMEOUT_MS,
    });
    expect(stdout.trim()).toBe(PACKAGE_VERSION);
  });
});

// Any other argument used to fall through to startServer() and block on stdin
// with no output, so a typo looked like a hung package. It must now fail fast,
// and the no-argument launch every MCP host relies on must still serve.
describe("argument handling", () => {
  // A word-shaped typo and a flag-shaped one, so a guard that only rejects one
  // shape cannot pass.
  it.skipIf(!buildAvailable).each(["versoin", "--help"])(
    "'%s' exits 1 with usage on stderr and nothing on stdout",
    (arg) => {
      // spawnSync closes the child's stdin at once. In a terminal a regressed
      // guard blocks forever; here it reaches startServer(), hits EOF and
      // exits 0 with no output -- so the status and stderr assertions are what
      // catch it (verified by deleting the guard: both cases go red on status).
      const result = spawnSync(process.execPath, [DIST_BIN, arg], {
        encoding: "utf-8",
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Unknown subcommand: ${arg}`);
      expect(result.stderr).toContain("Usage: fetch-mcp [version|--version]");
      // stdout is the MCP channel; a diagnostic there would corrupt a host's
      // JSON-RPC stream.
      expect(result.stdout).toBe("");
    },
  );

  it.skipIf(!buildAvailable)("no argument still starts the MCP server and answers initialize", async () => {
    const child = spawn(process.execPath, [DIST_BIN], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const firstLine = new Promise<string>((resolveLine, reject) => {
        let buffered = "";
        let stderr = "";
        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          buffered += chunk;
          const newline = buffered.indexOf("\n");
          if (newline !== -1) resolveLine(buffered.slice(0, newline));
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`server exited (${code}) before responding; stderr: ${stderr}`)));
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "version-test", version: "0.0.0" },
          },
        })}\n`,
      );

      const response = JSON.parse(await firstLine);
      expect(response.id).toBe(1);
      expect(response.result.serverInfo).toEqual({ name: "fetch-mcp", version: PACKAGE_VERSION });
    } finally {
      child.kill();
    }
  });
});
