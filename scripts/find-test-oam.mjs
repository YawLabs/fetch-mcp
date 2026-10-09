#!/usr/bin/env node
/**
 * Print the oam binary release.sh should run the real-oam lane
 * (src/tests/oam.integration.test.ts) on, or exit 1 with the reason on stderr.
 *
 * The lane exists for the class of bug a Node-only suite cannot see -- oam's
 * fetch, zlib, AbortSignal and permission model -- so release.sh runs it after
 * the build whenever an oam at or above the launcher's OAM_MIN can be found.
 *
 * Search order, newest usable wins (a tie keeps the earlier one), mirroring the
 * launcher's discovery: FETCH_MCP_TEST_OAM (used as given when usable),
 * OAM_INSTALL_DIR, the installed locations, then PATH. The path printed is a
 * native one, so a Windows Node can open it (a Git Bash `/c/...` path made the
 * lane skip itself).
 *
 * Usage: node scripts/find-test-oam.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

const launcher = readFileSync(join(REPO_ROOT, "bin", "fetch-mcp.mjs"), "utf8");
const m = /const OAM_MIN = \[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(launcher);
if (!m) {
  console.error("could not find `const OAM_MIN = [x, y, z]` in bin/fetch-mcp.mjs");
  process.exit(2);
}
const OAM_MIN = [Number(m[1]), Number(m[2]), Number(m[3])];

function version(cmd) {
  try {
    return parseVersion(
      execFileSync(cmd, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
        windowsHide: true,
      }),
    );
  } catch {
    return null;
  }
}

const candidates = [];
if (process.env.FETCH_MCP_TEST_OAM) candidates.push(process.env.FETCH_MCP_TEST_OAM);
if (process.env.OAM_INSTALL_DIR) candidates.push(join(process.env.OAM_INSTALL_DIR, exe));
if (isWin) candidates.push(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
candidates.push(join(homedir(), ".oam", "bin", exe));
for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, exe));

const seen = new Set();
const rejected = [];
let best = null;
for (const path of candidates) {
  const key = isWin ? resolve(path).toLowerCase() : resolve(path);
  if (seen.has(key) || !existsSync(path)) continue;
  seen.add(key);
  const v = version(path);
  if (!atLeast(v, OAM_MIN)) {
    rejected.push(`${path} (${v ? `oam ${v.join(".")}` : "could not be run"})`);
    continue;
  }
  if (!best || !atLeast(best.v, v)) best = { path: resolve(path), v };
}

if (best) {
  console.log(best.path);
  process.exit(0);
}
console.error(
  `no oam ${OAM_MIN.join(".")} or newer found` + (rejected.length ? `; passed over: ${rejected.join(", ")}` : ""),
);
process.exit(1);
