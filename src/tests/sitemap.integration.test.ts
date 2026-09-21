import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setHttpContext } from "../http.js";
import { createFetchServer } from "../server.js";

setHttpContext({ version: "test" });

let server: Server;
let baseUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse, url: URL) => void = () => {};

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    handler(req, res, url);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Exercise the `fetch_sitemap` tool end-to-end. */
async function callSitemap(
  input: Record<string, unknown>,
): Promise<{ parsed: Record<string, unknown> | null; raw: string; isError: boolean }> {
  // Loopback fixtures need the operator opt-in for allow_private_hosts.
  const s = createFetchServer({ allowPrivateHosts: true });
  const tools = (
    s as unknown as {
      _registeredTools: Record<
        string,
        { handler: (input: unknown, extra: { signal: AbortSignal }) => Promise<unknown> }
      >;
    }
  )._registeredTools;
  const tool = tools.fetch_sitemap;
  const out = (await tool.handler(input, { signal: new AbortController().signal })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const raw = out.content[0]!.text;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* error messages are plain strings */
  }
  return { parsed, raw, isError: Boolean(out.isError) };
}

describe("fetch_sitemap integration", () => {
  it("returns warnings (not error) when one child sitemap in an index fails", async () => {
    handler = (_req, res, url) => {
      if (url.pathname === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${baseUrl}/good.xml</loc></sitemap>
  <sitemap><loc>${baseUrl}/bad.xml</loc></sitemap>
</sitemapindex>`);
      } else if (url.pathname === "/good.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/a</loc></url>
  <url><loc>${baseUrl}/b</loc></url>
</urlset>`);
      } else if (url.pathname === "/bad.xml") {
        res.statusCode = 500;
        res.end("boom");
      } else {
        res.statusCode = 404;
        res.end();
      }
    };
    const { parsed, isError } = await callSitemap({
      url: `${baseUrl}/sitemap.xml`,
      allow_private_hosts: true,
      max_depth: 1,
    });
    expect(isError).toBe(false);
    expect(parsed).not.toBeNull();
    expect(parsed!.urlCount).toBe(2);
    const warnings = parsed!.warnings as Array<{ url: string; error: string }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.url).toContain("/bad.xml");
  });

  it("exposes childSitemaps when max_depth=0 is called on a sitemap index", async () => {
    handler = (_req, res, url) => {
      if (url.pathname === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${baseUrl}/child1.xml</loc></sitemap>
  <sitemap><loc>${baseUrl}/child2.xml</loc></sitemap>
</sitemapindex>`);
      } else {
        res.statusCode = 404;
        res.end();
      }
    };
    const { parsed, isError } = await callSitemap({
      url: `${baseUrl}/sitemap.xml`,
      allow_private_hosts: true,
      max_depth: 0,
    });
    expect(isError).toBe(false);
    expect(parsed!.urlCount).toBe(0);
    const children = parsed!.childSitemaps as string[];
    expect(children).toHaveLength(2);
    expect(children.some((c) => c.endsWith("/child1.xml"))).toBe(true);
    expect(children.some((c) => c.endsWith("/child2.xml"))).toBe(true);
  });

  it("auto-decompresses a gzipped sitemap discovered via an index", async () => {
    const gzPayload = gzipSync(
      Buffer.from(
        `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/from-gz</loc></url>
</urlset>`,
        "utf8",
      ),
    );
    handler = (_req, res, url) => {
      if (url.pathname === "/sitemap.xml") {
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${baseUrl}/child.xml.gz</loc></sitemap>
</sitemapindex>`);
      } else if (url.pathname === "/child.xml.gz") {
        // Serve as application/x-gzip with no Content-Encoding -- the scenario node fetch won't auto-decode.
        res.setHeader("content-type", "application/x-gzip");
        res.end(gzPayload);
      } else {
        res.statusCode = 404;
        res.end();
      }
    };
    const { parsed, isError } = await callSitemap({
      url: `${baseUrl}/sitemap.xml`,
      allow_private_hosts: true,
      max_depth: 1,
    });
    expect(isError).toBe(false);
    expect(parsed!.urlCount).toBe(1);
    const urls = parsed!.urls as Array<{ loc: string }>;
    expect(urls[0]!.loc).toContain("/from-gz");
  });

  it("returns error when the very first sitemap fetch fails", async () => {
    handler = (_req, res) => {
      res.statusCode = 500;
      res.end("down");
    };
    const { raw, isError } = await callSitemap({
      url: `${baseUrl}/sitemap.xml`,
      allow_private_hosts: true,
    });
    expect(isError).toBe(true);
    expect(raw).toContain("500");
  });

  it("caps the DECOMPRESSED size of a gzipped sitemap at max_bytes (gzip bomb)", async () => {
    // A valid-looking sitemap padded with whitespace: tiny on the wire, huge inflated.
    const inflated = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${" ".repeat(8 * 1024 * 1024)}</urlset>`;
    const bomb = gzipSync(Buffer.from(inflated, "utf8"));
    handler = (_req, res, url) => {
      if (url.pathname === "/bomb.xml.gz") {
        res.setHeader("content-type", "application/x-gzip");
        res.end(bomb);
      } else {
        res.statusCode = 404;
        res.end();
      }
    };
    const maxBytes = 256 * 1024;
    expect(bomb.length).toBeLessThan(maxBytes);
    const { raw, isError } = await callSitemap({
      url: `${baseUrl}/bomb.xml.gz`,
      allow_private_hosts: true,
      max_bytes: maxBytes,
    });
    expect(isError).toBe(true);
    expect(raw).toMatch(new RegExp(`decompresses past ${maxBytes} bytes`));
  });
});

describe("fetch_sitemap fan-out cap (max_sitemaps)", () => {
  /** An index at /index.xml listing `n` children, each a one-URL urlset; counts requests. */
  function serveIndex(n: number): { requests: () => number } {
    let count = 0;
    handler = (_req, res, url) => {
      count++;
      res.setHeader("content-type", "application/xml");
      if (url.pathname === "/index.xml") {
        const children = Array.from({ length: n }, (_, i) => `<sitemap><loc>${baseUrl}/child-${i}.xml</loc></sitemap>`);
        res.end(
          `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children.join("")}</sitemapindex>`,
        );
      } else {
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${baseUrl}${url.pathname}#page</loc></url></urlset>`,
        );
      }
    };
    return { requests: () => count };
  }

  it("fetches at most 50 sitemap documents by default and lists the rest, unfetched", async () => {
    // Through 0.7.1 an index listing N children produced N+1 requests -- 3000
    // children meant 3001 requests from one tool call.
    const server = serveIndex(120);
    const { parsed, isError } = await callSitemap({ url: `${baseUrl}/index.xml`, allow_private_hosts: true });

    expect(isError).toBe(false);
    expect(server.requests()).toBe(50);
    expect(parsed!.sitemaps).toHaveLength(50);
    expect(parsed!.urlCount).toBe(49);
    const unfetched = parsed!.childSitemaps as string[];
    expect(unfetched).toHaveLength(71);
    expect(unfetched[0]).toBe(`${baseUrl}/child-49.xml`);
    const warnings = parsed!.warnings as Array<{ url: string; error: string }>;
    expect(warnings).toEqual([
      {
        url: `${baseUrl}/index.xml`,
        error: "max_sitemaps (50) reached: 71 child sitemap(s) not fetched, listed under childSitemaps",
      },
    ]);
  });

  it("honours an explicit max_sitemaps", async () => {
    const server = serveIndex(10);
    const { parsed } = await callSitemap({ url: `${baseUrl}/index.xml`, allow_private_hosts: true, max_sitemaps: 3 });

    expect(server.requests()).toBe(3);
    expect(parsed!.urlCount).toBe(2);
    expect(parsed!.childSitemaps).toHaveLength(8);
  });

  it("does not warn when the index fits under the cap", async () => {
    const server = serveIndex(5);
    const { parsed } = await callSitemap({ url: `${baseUrl}/index.xml`, allow_private_hosts: true });

    expect(server.requests()).toBe(6);
    expect(parsed!.urlCount).toBe(5);
    expect(parsed!.warnings).toEqual([]);
    expect(parsed!.childSitemaps).toEqual([]);
  });
});

describe("fetch_sitemap refuses a sitemap truncated at max_bytes", () => {
  const bigUrlset = () =>
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from(
      { length: 200 },
      (_, i) => `<url><loc>${baseUrl}/page-${i}</loc></url>`,
    ).join("")}</urlset>`;

  it("errors on a top-level sitemap cut off by max_bytes instead of returning the partial URL list", async () => {
    // Through 0.7.1 the parser accepted the cut-off XML and returned however
    // many <url> entries fit, with no sign anything was missing.
    handler = (_req, res) => {
      res.setHeader("content-type", "application/xml");
      res.end(bigUrlset());
    };
    const { raw, isError } = await callSitemap({
      url: `${baseUrl}/big.xml`,
      allow_private_hosts: true,
      max_bytes: 4096,
    });

    expect(isError).toBe(true);
    expect(raw).toContain("sitemap is larger than max_bytes (4096 bytes); raise max_bytes to read it");
  });

  it("turns a truncated CHILD into a warning and keeps the rest", async () => {
    handler = (_req, res, url) => {
      res.setHeader("content-type", "application/xml");
      if (url.pathname === "/index.xml") {
        res.end(
          `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${baseUrl}/small.xml</loc></sitemap><sitemap><loc>${baseUrl}/big.xml</loc></sitemap></sitemapindex>`,
        );
      } else if (url.pathname === "/small.xml") {
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${baseUrl}/a</loc></url></urlset>`,
        );
      } else {
        res.end(bigUrlset());
      }
    };
    const { parsed, isError } = await callSitemap({
      url: `${baseUrl}/index.xml`,
      allow_private_hosts: true,
      max_bytes: 4096,
    });

    expect(isError).toBe(false);
    expect(parsed!.urlCount).toBe(1);
    expect(parsed!.warnings).toEqual([
      { url: `${baseUrl}/big.xml`, error: "sitemap is larger than max_bytes (4096 bytes); raise max_bytes to read it" },
    ]);
  });

  it("still reads a sitemap that fits under max_bytes", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "application/xml");
      res.end(bigUrlset());
    };
    const { parsed, isError } = await callSitemap({
      url: `${baseUrl}/big.xml`,
      allow_private_hosts: true,
      max_urls: 50_000,
    });

    expect(isError).toBe(false);
    expect(parsed!.urlCount).toBe(200);
  });
});
