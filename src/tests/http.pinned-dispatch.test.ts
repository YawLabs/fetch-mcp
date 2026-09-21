import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { type AddressInfo, createServer as createTcpServer, type Socket, type Server as TcpServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real-socket coverage for the guarded HOSTNAME path: resolveAndPin -> pinnedAgent
// -> fetch, with nothing mocked between the dispatcher and the wire.
//
// Through 0.7.0 http.ts paired undici 8's Agent with the runtime's GLOBAL fetch.
// On Node 22 and 24 that fetch is an older bundled undici (6.x / 7.x) which
// drives dispatchers through the legacy handler API, and undici 8 rejects it
// (UND_ERR_INVALID_ARG, "invalid onRequestStart method") -- so every guarded
// hostname request failed with "fetch failed" on plain Node, 0.4.0 through
// 0.7.0. The mock-based suites could not see it: they replace fetch. This one
// does not.
//
// To dial a local fixture through the pinned path, DNS is mocked so
// `pinned.test` answers 127.0.0.1, and checkIpAddress is relaxed for exactly
// that address. validateUrl stays real (a hostname never reaches its literal
// check), so the redirect test below still exercises the real block list.

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

vi.mock("../security.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../security.js")>();
  return { ...real, checkIpAddress: (ip: string) => (ip === "127.0.0.1" ? null : real.checkIpAddress(ip)) };
});

const { httpRequest, setHttpContext } = await import("../http.js");

setHttpContext({ version: "test" });

let server: Server;
let port: number;
let seen: Array<{ host: string | undefined; path: string | undefined }> = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    seen.push({ host: req.headers.host, path: req.url });
    if (req.url === "/to-literal") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned-ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
});

describe("guarded hostname requests dial through the pinned dispatcher", () => {
  it("completes a real round-trip on this runtime (regression: 'fetch failed' on Node 22/24)", async () => {
    const res = await httpRequest({ method: "GET", url: `http://pinned.test:${port}/hello` });

    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe("pinned-ok");
    expect(lookupMock).toHaveBeenCalledWith("pinned.test", expect.objectContaining({ all: true }));
    // The socket went to the pinned IP while the Host header kept the name.
    expect(seen).toEqual([{ host: `pinned.test:${port}`, path: "/hello" }]);
  });

  it("still refuses a redirect from the pinned host to a literal loopback IP", async () => {
    const res = await httpRequest({ method: "GET", url: `http://pinned.test:${port}/to-literal` });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/127\.0\.0\.1.*reserved/);
    // Only the redirecting hop reached the server; /secret was never requested.
    expect(seen.map((s) => s.path)).toEqual(["/to-literal"]);
  });
});

describe("a hop aborted mid-connect lets go at once", () => {
  // A server that accepts TCP and never answers the TLS ClientHello: the pinned
  // Agent is still "connecting" when the deadline or the cancellation fires.
  // sendHop used to `await dispatcher.close()`, which waits out undici's 10s
  // connect timeout -- the call returned "request exceeded 300ms" after ~10.6s.
  let stall: TcpServer;
  let stallPort: number;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    stall = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((done) => stall.listen(0, "127.0.0.1", () => done()));
    stallPort = (stall.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((done) => stall.close(() => done()));
  });

  it("returns on timeout_ms, not after undici's 10s connect timeout", async () => {
    const t0 = Date.now();
    const res = await httpRequest({ method: "GET", url: `https://pinned.test:${stallPort}/`, timeoutMs: 300 });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("request exceeded 300ms");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("returns on cancellation, not after undici's 10s connect timeout", async () => {
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 200);
    const t0 = Date.now();
    const res = await httpRequest({
      method: "GET",
      url: `https://pinned.test:${stallPort}/`,
      timeoutMs: 30_000,
      signal: cancel.signal,
    });

    expect(res.error).toBe("request cancelled by the client");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
