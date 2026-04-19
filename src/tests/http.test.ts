import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpRequest, setHttpContext } from "../http.js";

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

describe("httpRequest — SSRF pre-flight", () => {
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

describe("httpRequest — happy path", () => {
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

describe("httpRequest — response size cap", () => {
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

describe("httpRequest — redirects", () => {
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
});

describe("httpRequest — timeout", () => {
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

describe("httpRequest — retries", () => {
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
});

describe("httpRequest — HEAD", () => {
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

describe("httpRequest — binary", () => {
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
});

describe("createServer sanity", () => {
  it("net server module is importable in this runtime", () => {
    const s = createServer();
    expect(s).toBeDefined();
    s.close();
  });
});
