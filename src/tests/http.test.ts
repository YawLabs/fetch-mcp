import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeBytes,
  extractCharset,
  httpRequest,
  parseRetryAfter,
  setHttpContext,
  shouldDecodeAsText,
} from "../http.js";

setHttpContext({ version: "test" });

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    handler(req, res, url);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function setHandler(h: Handler) {
  handler = h;
}

describe("httpRequest -- SSRF pre-flight", () => {
  it("blocks non-http schemes", async () => {
    const res = await httpRequest({ method: "GET", url: "file:///etc/passwd" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/scheme/);
  });

  it("blocks literal private hosts by default", async () => {
    const res = await httpRequest({ method: "GET", url: "http://127.0.0.1/" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reserved|loopback|private/);
  });

  it("allows private hosts when allowPrivateHosts is set", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true });
    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe("ok");
  });
});

describe("httpRequest -- happy path", () => {
  it("performs a GET and returns status, headers, body", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.setHeader("x-test", "custom");
      res.end("hello");
    });
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.bodyText).toBe("hello");
    expect(res.headers["x-test"]).toBe("custom");
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("auto-parses JSON responses", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ foo: "bar", n: 42 }));
    });
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true });
    expect(res.json).toEqual({ foo: "bar", n: 42 });
    expect(res.bodyText).toContain("foo");
  });

  it("sends POST with a JSON body", async () => {
    let received = "";
    let receivedType = "";
    setHandler((req, res) => {
      receivedType = req.headers["content-type"] ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received = Buffer.concat(chunks).toString("utf8");
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
    });
    const res = await httpRequest({
      method: "POST",
      url: baseUrl,
      body: JSON.stringify({ x: 1 }),
      contentType: "application/json",
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(received).toBe('{"x":1}');
    expect(receivedType).toBe("application/json");
  });

  it("supports custom request headers", async () => {
    let auth = "";
    setHandler((req, res) => {
      auth = req.headers.authorization ?? "";
      res.end("ok");
    });
    await httpRequest({
      method: "GET",
      url: baseUrl,
      headers: { Authorization: "Bearer abc" },
      allowPrivateHosts: true,
    });
    expect(auth).toBe("Bearer abc");
  });

  it("sets Basic auth header from basicAuth option", async () => {
    let auth = "";
    setHandler((req, res) => {
      auth = req.headers.authorization ?? "";
      res.end("ok");
    });
    await httpRequest({
      method: "GET",
      url: baseUrl,
      basicAuth: { username: "user", password: "pass" },
      allowPrivateHosts: true,
    });
    const expected = `Basic ${Buffer.from("user:pass", "utf8").toString("base64")}`;
    expect(auth).toBe(expected);
  });

  it("sets Bearer token header from bearerToken option", async () => {
    let auth = "";
    setHandler((req, res) => {
      auth = req.headers.authorization ?? "";
      res.end("ok");
    });
    await httpRequest({
      method: "GET",
      url: baseUrl,
      bearerToken: "sk-abc-123",
      allowPrivateHosts: true,
    });
    expect(auth).toBe("Bearer sk-abc-123");
  });

  it("sets the default user-agent when none provided", async () => {
    let ua = "";
    setHandler((req, res) => {
      ua = req.headers["user-agent"] ?? "";
      res.end("ok");
    });
    await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true });
    expect(ua).toContain("@yawlabs/fetch-mcp");
  });

  it("lets caller override the user-agent", async () => {
    let ua = "";
    setHandler((req, res) => {
      ua = req.headers["user-agent"] ?? "";
      res.end("ok");
    });
    await httpRequest({ method: "GET", url: baseUrl, userAgent: "custom/1.0", allowPrivateHosts: true });
    expect(ua).toBe("custom/1.0");
  });
});

describe("httpRequest -- response size cap", () => {
  it("truncates when max_bytes is exceeded", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("a".repeat(10_000));
    });
    const res = await httpRequest({
      method: "GET",
      url: baseUrl,
      maxBytes: 100,
      allowPrivateHosts: true,
    });
    expect(res.truncated).toBe(true);
    expect(res.bodyText?.length).toBeLessThanOrEqual(100);
  });

  it("does not truncate when under the cap", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("short");
    });
    const res = await httpRequest({
      method: "GET",
      url: baseUrl,
      maxBytes: 1000,
      allowPrivateHosts: true,
    });
    expect(res.truncated).toBeFalsy();
    expect(res.bodyText).toBe("short");
  });
});

describe("httpRequest -- redirects", () => {
  it("follows redirects and records the chain", async () => {
    setHandler((_req, res, url) => {
      if (url.pathname === "/start") {
        res.statusCode = 302;
        res.setHeader("location", "/middle");
        res.end();
      } else if (url.pathname === "/middle") {
        res.statusCode = 302;
        res.setHeader("location", "/end");
        res.end();
      } else {
        res.statusCode = 200;
        res.end("arrived");
      }
    });
    const res = await httpRequest({
      method: "GET",
      url: `${baseUrl}/start`,
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe("arrived");
    expect(res.redirects).toHaveLength(2);
  });

  it("refuses redirect loops past max_redirects", async () => {
    setHandler((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", "/loop");
      res.end();
    });
    const res = await httpRequest({
      method: "GET",
      url: `${baseUrl}/loop`,
      maxRedirects: 3,
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/redirects/);
  });

  it("downgrades POST to GET on 303", async () => {
    let secondMethod = "";
    let secondBody = "";
    setHandler((req, res, url) => {
      if (url.pathname === "/redirect") {
        res.statusCode = 303;
        res.setHeader("location", "/target");
        res.end();
        return;
      }
      secondMethod = req.method ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        secondBody = Buffer.concat(chunks).toString("utf8");
        res.statusCode = 200;
        res.end("ok");
      });
    });
    const res = await httpRequest({
      method: "POST",
      url: `${baseUrl}/redirect`,
      body: '{"x":1}',
      contentType: "application/json",
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(true);
    expect(secondMethod).toBe("GET");
    expect(secondBody).toBe("");
  });

  it("downgrades POST to GET on 301/302 per WHATWG fetch", async () => {
    let secondMethod = "";
    setHandler((req, res, url) => {
      if (url.pathname === "/redirect") {
        res.statusCode = 302;
        res.setHeader("location", "/target");
        res.end();
        return;
      }
      secondMethod = req.method ?? "";
      res.statusCode = 200;
      res.end("ok");
    });
    const res = await httpRequest({
      method: "POST",
      url: `${baseUrl}/redirect`,
      body: '{"x":1}',
      contentType: "application/json",
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(true);
    expect(secondMethod).toBe("GET");
  });

  it("preserves POST method and body on 307", async () => {
    let secondMethod = "";
    let secondBody = "";
    setHandler((req, res, url) => {
      if (url.pathname === "/redirect") {
        res.statusCode = 307;
        res.setHeader("location", "/target");
        res.end();
        return;
      }
      secondMethod = req.method ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        secondBody = Buffer.concat(chunks).toString("utf8");
        res.statusCode = 200;
        res.end("ok");
      });
    });
    const res = await httpRequest({
      method: "POST",
      url: `${baseUrl}/redirect`,
      body: '{"x":1}',
      contentType: "application/json",
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(true);
    expect(secondMethod).toBe("POST");
    expect(secondBody).toBe('{"x":1}');
  });
});

describe("httpRequest -- cross-origin auth leakage", () => {
  it("strips Authorization from bearerToken on cross-origin redirect", async () => {
    // First server sends a redirect to a second server on a different port.
    let secondServer: Server;
    let secondAuth: string | undefined;
    await new Promise<void>((resolve) => {
      secondServer = createHttpServer((req, res) => {
        secondAuth = req.headers.authorization;
        res.statusCode = 200;
        res.end("landed");
      });
      secondServer.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const secondAddr = secondServer!.address() as AddressInfo;
      const secondUrl = `http://127.0.0.1:${secondAddr.port}`;
      setHandler((_req, res) => {
        res.statusCode = 302;
        res.setHeader("location", secondUrl);
        res.end();
      });
      const res = await httpRequest({
        method: "GET",
        url: baseUrl,
        bearerToken: "sk-secret",
        allowPrivateHosts: true,
      });
      expect(res.ok).toBe(true);
      expect(secondAuth).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => secondServer!.close(() => resolve()));
    }
  });

  it("preserves Authorization on same-origin redirect", async () => {
    let secondAuth: string | undefined;
    setHandler((req, res, url) => {
      if (url.pathname === "/start") {
        res.statusCode = 302;
        res.setHeader("location", "/next");
        res.end();
        return;
      }
      secondAuth = req.headers.authorization;
      res.statusCode = 200;
      res.end("ok");
    });
    const res = await httpRequest({
      method: "GET",
      url: `${baseUrl}/start`,
      bearerToken: "sk-secret",
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(true);
    expect(secondAuth).toBe("Bearer sk-secret");
  });

  it("strips Authorization from custom headers on cross-origin", async () => {
    let secondServer: Server;
    let secondAuth: string | undefined;
    await new Promise<void>((resolve) => {
      secondServer = createHttpServer((req, res) => {
        secondAuth = req.headers.authorization;
        res.statusCode = 200;
        res.end("landed");
      });
      secondServer.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const secondAddr = secondServer!.address() as AddressInfo;
      const secondUrl = `http://127.0.0.1:${secondAddr.port}`;
      setHandler((_req, res) => {
        res.statusCode = 302;
        res.setHeader("location", secondUrl);
        res.end();
      });
      await httpRequest({
        method: "GET",
        url: baseUrl,
        headers: { Authorization: "Basic abc=" },
        allowPrivateHosts: true,
      });
      expect(secondAuth).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => secondServer!.close(() => resolve()));
    }
  });
});

describe("httpRequest -- timeout", () => {
  it("aborts when the server is slow", async () => {
    setHandler(() => {
      // never respond
    });
    const res = await httpRequest({
      method: "GET",
      url: baseUrl,
      timeoutMs: 150,
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/abort|timeout|aborted|exceeded/i);
  });
});

describe("httpRequest -- retries", () => {
  it("retries on 503 and eventually succeeds", async () => {
    let count = 0;
    setHandler((_req, res) => {
      count++;
      if (count < 3) {
        res.statusCode = 503;
        res.end("try later");
      } else {
        res.statusCode = 200;
        res.end("ok now");
      }
    });
    const res = await httpRequest({
      method: "GET",
      url: baseUrl,
      retries: 3,
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe("ok now");
    expect(count).toBe(3);
  });

  it("returns the last failure when retries are exhausted", async () => {
    setHandler((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    const res = await httpRequest({
      method: "GET",
      url: baseUrl,
      retries: 1,
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });

  it("resets redirect chain between retry attempts", async () => {
    let attempt = 0;
    setHandler((_req, res, url) => {
      if (url.pathname === "/start") {
        res.statusCode = 302;
        res.setHeader("location", "/target");
        res.end();
        return;
      }
      attempt++;
      if (attempt < 2) {
        res.statusCode = 503;
        res.end("retry me");
      } else {
        res.statusCode = 200;
        res.end("final");
      }
    });
    const res = await httpRequest({
      method: "GET",
      url: `${baseUrl}/start`,
      retries: 2,
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(true);
    expect(res.bodyText).toBe("final");
    // After a successful attempt, redirects should reflect only that attempt's hops (exactly one).
    expect(res.redirects).toHaveLength(1);
  });

  it("honors Retry-After in seconds form", async () => {
    let first = 0;
    let secondAt = 0;
    setHandler((_req, res) => {
      const now = Date.now();
      if (first === 0) {
        first = now;
        res.statusCode = 429;
        res.setHeader("retry-after", "1");
        res.end("slow down");
      } else {
        secondAt = now;
        res.statusCode = 200;
        res.end("ok");
      }
    });
    const res = await httpRequest({
      method: "GET",
      url: baseUrl,
      retries: 1,
      allowPrivateHosts: true,
    });
    expect(res.ok).toBe(true);
    expect(secondAt - first).toBeGreaterThanOrEqual(900);
  });
});

describe("httpRequest -- HEAD", () => {
  it("returns headers without body", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-length", "100");
      res.setHeader("etag", "abc123");
      res.end("body-should-be-ignored-on-head");
    });
    const res = await httpRequest({ method: "HEAD", url: baseUrl, allowPrivateHosts: true });
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe("abc123");
    expect(res.bodyText).toBeUndefined();
  });
});

describe("httpRequest -- binary / charset", () => {
  it("returns base64 when decodeText is false", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([0, 1, 2, 255]));
    });
    const res = await httpRequest({
      method: "GET",
      url: baseUrl,
      allowPrivateHosts: true,
      decodeText: false,
    });
    expect(res.bodyBase64).toBe(Buffer.from([0, 1, 2, 255]).toString("base64"));
    expect(res.bodyText).toBeUndefined();
  });

  it("auto-mode returns base64 for binary content types", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from([137, 80, 78, 71]));
    });
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true });
    expect(res.bodyBase64).toBe(Buffer.from([137, 80, 78, 71]).toString("base64"));
    expect(res.bodyText).toBeUndefined();
  });

  it("auto-mode returns text for text/html", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<p>hi</p>");
    });
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true });
    expect(res.bodyText).toBe("<p>hi</p>");
  });

  it("decodes iso-8859-1 bodies", async () => {
    setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=iso-8859-1");
      // 0xE9 = 'é' in iso-8859-1
      res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9])); // café
    });
    const res = await httpRequest({ method: "GET", url: baseUrl, allowPrivateHosts: true });
    expect(res.bodyText).toBe("café");
  });
});

describe("helpers", () => {
  it("shouldDecodeAsText picks right category", () => {
    expect(shouldDecodeAsText("text/html")).toBe(true);
    expect(shouldDecodeAsText("text/plain; charset=utf-8")).toBe(true);
    expect(shouldDecodeAsText("application/json")).toBe(true);
    expect(shouldDecodeAsText("application/vnd.api+json")).toBe(true);
    expect(shouldDecodeAsText("application/xml")).toBe(true);
    expect(shouldDecodeAsText("application/atom+xml")).toBe(true);
    expect(shouldDecodeAsText("application/javascript")).toBe(true);
    expect(shouldDecodeAsText("application/x-www-form-urlencoded")).toBe(true);
    expect(shouldDecodeAsText("application/octet-stream")).toBe(false);
    expect(shouldDecodeAsText("image/png")).toBe(false);
    expect(shouldDecodeAsText("application/pdf")).toBe(false);
  });

  it("extractCharset reads from Content-Type", () => {
    expect(extractCharset("text/html; charset=utf-8")).toBe("utf-8");
    expect(extractCharset("text/html; charset=ISO-8859-1")).toBe("iso-8859-1");
    expect(extractCharset('text/html; charset="utf-8"')).toBe("utf-8");
    expect(extractCharset("text/html")).toBe("utf-8");
  });

  it("decodeBytes falls back to utf-8 on unknown label", () => {
    const bytes = Buffer.from("hi", "utf8");
    expect(decodeBytes(bytes, "text/html; charset=not-a-real-charset")).toBe("hi");
  });

  it("parseRetryAfter accepts seconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parseRetryAfter accepts HTTP-date", () => {
    const now = Date.parse("2026-04-21T12:00:00Z");
    const then = "Tue, 21 Apr 2026 12:00:05 GMT";
    expect(parseRetryAfter(then, now)).toBe(5000);
  });

  it("parseRetryAfter clamps to 60 seconds", () => {
    expect(parseRetryAfter("600")).toBe(60_000);
  });

  it("parseRetryAfter returns undefined on garbage", () => {
    expect(parseRetryAfter("not-a-delay")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
  });
});

describe("createServer sanity", () => {
  it("net server module is importable in this runtime", () => {
    const s = createServer();
    expect(s).toBeDefined();
    s.close();
  });
});
