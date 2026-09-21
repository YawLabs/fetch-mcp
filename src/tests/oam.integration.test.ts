import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The server under a REAL oam, through the launcher, with the sandbox on.
//
// The rest of the suite runs on Node, and oam is the launcher's preferred
// runtime: a Node-only suite passed while oam silently ignored zlib's
// `maxOutputLength` (the gzip-bomb cap did nothing there) -- found by hand in
// 0.7.1's review, not by a test. This lane exists for that class of bug.
//
// Opt-in: set FETCH_MCP_TEST_OAM to an oam binary at or above the launcher's
// OAM_MIN, e.g. FETCH_MCP_TEST_OAM=~/yaw/oam_js_runtime/oam/target/release/oam.
// Without it, or without a build, the lane is skipped.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const LAUNCHER = resolve(REPO_ROOT, "bin", "fetch-mcp.mjs");
const DIST_BIN = resolve(REPO_ROOT, "dist", "index.js");
const OAM = process.env.FETCH_MCP_TEST_OAM;
const available = Boolean(OAM && existsSync(OAM) && existsSync(DIST_BIN));
// An oam start plus a handshake; generous for a loaded Windows box.
const TIMEOUT_MS = 60_000;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let fixture: Server;
let base: string;
let handler: Handler = (_req, res) => res.end("ok");
const closedEarly: string[] = [];

beforeAll(async () => {
  fixture = createServer((req, res) => {
    req.on("close", () => {
      if (!res.writableEnded) closedEarly.push(req.url ?? "");
    });
    handler(req, res);
  });
  await new Promise<void>((done) => fixture.listen(0, "127.0.0.1", () => done()));
  base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
});

afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise<void>((done) => fixture.close(() => done()));
});

interface Session {
  call(
    name: string,
    args: Record<string, unknown>,
    id?: number,
  ): Promise<{ text: string; isError: boolean; ms: number }>;
  send(message: Record<string, unknown>): void;
  stderr(): string;
  serverVersion: string;
  close(): void;
}

/** Start the launcher on oam with the sandbox, complete the MCP handshake, return a small client. */
async function startOnOam(extraEnv: Record<string, string> = {}): Promise<Session> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [LAUNCHER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      FETCH_MCP_RUNTIME: "oam",
      FETCH_MCP_SANDBOX: "1",
      OAM_BIN: OAM!,
      FETCH_MCP_ALLOW_PRIVATE_HOSTS: "",
      ...extraEnv,
    },
  });
  let stderr = "";
  let buffered = "";
  const waiters = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (c: string) => {
    stderr += c;
  });
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!line.trim()) continue;
      // Every stdout line must be one whole JSON-RPC message: a line that fails
      // to parse is the truncated-write class of bug this lane watches for.
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (typeof msg.id === "number") waiters.get(msg.id)?.(msg);
    }
  });
  const exited = new Promise<never>((_, reject) =>
    child.on("exit", (code) => reject(new Error(`server exited (${code}); stderr: ${stderr}`))),
  );
  exited.catch(() => {});
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (id: number, method: string, params: unknown) => {
    const answered = new Promise<{ result?: unknown; error?: unknown }>((done) => waiters.set(id, done));
    send({ id, method, params });
    return Promise.race([answered, exited]);
  };

  const init = (await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "oam-lane", version: "0.0.0" },
  })) as { result: { serverInfo: { version: string } } };
  send({ method: "notifications/initialized" });

  let nextId = 100;
  return {
    serverVersion: init.result.serverInfo.version,
    send,
    stderr: () => stderr,
    close: () => child.kill(),
    async call(name, args, id = nextId++) {
      const t0 = Date.now();
      const msg = (await request(id, "tools/call", { name, arguments: args })) as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      };
      return { text: msg.result.content[0]!.text, isError: Boolean(msg.result.isError), ms: Date.now() - t0 };
    },
  };
}

describe.skipIf(!available)("on a real oam, sandboxed (FETCH_MCP_TEST_OAM)", () => {
  it(
    "serves under --permission and refuses allow_private_hosts without the operator opt-in",
    async () => {
      const s = await startOnOam();
      try {
        expect(s.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
        // The sandbox was applied: no "runs WITHOUT --permission" note.
        expect(s.stderr()).not.toMatch(/WITHOUT --permission/);
        const out = await s.call("http_get", { url: `${base}/x`, allow_private_hosts: true });
        expect(out.isError).toBe(true);
        expect(out.text).toContain("allow_private_hosts is disabled on this server");
      } finally {
        s.close();
      }
    },
    TIMEOUT_MS,
  );

  it(
    "with FETCH_MCP_ALLOW_PRIVATE_HOSTS=1: the env grant reaches the server, the gzip cap holds, a near-cap reply arrives whole, and cancellation stops the fetch",
    async () => {
      const s = await startOnOam({ FETCH_MCP_ALLOW_PRIVATE_HOSTS: "1" });
      try {
        // (1) --allow-env=FETCH_MCP_ALLOW_PRIVATE_HOSTS: without the grant the
        // variable is invisible under --permission and this would be refused.
        handler = (_req, res) => res.end("INTERNAL-ONLY");
        const reached = await s.call("http_get", { url: `${base}/internal`, allow_private_hosts: true });
        expect(reached.text).toContain("INTERNAL-ONLY");

        // (2) The streaming gzip cap -- oam ignores zlib's maxOutputLength.
        const bomb = gzipSync(
          Buffer.from(
            `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${" ".repeat(64 * 1024 * 1024)}</urlset>`,
          ),
        );
        handler = (_req, res) => {
          res.setHeader("content-type", "application/x-gzip");
          res.end(bomb);
        };
        const refused = await s.call("fetch_sitemap", {
          url: `${base}/bomb.xml.gz`,
          allow_private_hosts: true,
          max_bytes: 1024 * 1024,
        });
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("decompresses past 1048576 bytes");

        // (3) A reply near the 50,000-character display cap arrives as one
        // parseable stdout line (JSON.parse in the reader would throw otherwise).
        const big = "x".repeat(49_000);
        handler = (_req, res) => {
          res.setHeader("content-type", "text/plain");
          res.end(big);
        };
        const whole = await s.call("http_get", { url: `${base}/big`, allow_private_hosts: true });
        expect(whole.text).toContain(big);

        // (4) notifications/cancelled: the cancelled call gets no answer and the
        // server keeps serving. NOT asserted: that the fixture sees the slow
        // connection close. On Node it closes the moment the cancel lands; on
        // oam 0.16.3 an aborted fetch leaves its socket open (to the response or
        // process exit) -- an oam divergence, reported upstream, that
        // fetch-mcp cannot fix from here. `closedEarly` records it for a reader.
        handler = (req, res) => {
          if (req.url === "/slow") setTimeout(() => res.end("too late"), 4000);
          else res.end("fast");
        };
        let slowAnswered = false;
        s.call("http_get", { url: `${base}/slow`, allow_private_hosts: true }, 500)
          .then(() => {
            slowAnswered = true;
          })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        s.send({ method: "notifications/cancelled", params: { requestId: 500, reason: "test" } });
        const next = await s.call("http_get", { url: `${base}/fast`, allow_private_hosts: true });
        expect(next.text).toContain("fast");
        expect(next.ms).toBeLessThan(3000);
        await new Promise((r) => setTimeout(r, 500));
        expect(slowAnswered).toBe(false);
      } finally {
        s.close();
      }
    },
    TIMEOUT_MS,
  );
});
