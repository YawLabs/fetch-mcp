import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ABSOLUTE_MAX_BYTES } from "../http.js";
import { decodeSitemapPayload, parseSitemapXml, sitemapByteCap } from "../tools/sitemap.js";

describe("parseSitemapXml", () => {
  it("parses a flat urlset", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/a</loc>
    <lastmod>2025-01-01</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/b</loc>
  </url>
</urlset>`;
    const parsed = parseSitemapXml(xml);
    expect(parsed.urls).toHaveLength(2);
    expect(parsed.urls[0]).toEqual({
      loc: "https://example.com/a",
      lastmod: "2025-01-01",
      changefreq: "daily",
      priority: 0.8,
    });
    expect(parsed.urls[1]).toEqual({ loc: "https://example.com/b" });
    expect(parsed.childSitemaps).toEqual([]);
  });

  it("parses a sitemap index", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;
    const parsed = parseSitemapXml(xml);
    expect(parsed.urls).toEqual([]);
    expect(parsed.childSitemaps).toEqual(["https://example.com/sitemap-1.xml", "https://example.com/sitemap-2.xml"]);
  });

  it("handles a single-url sitemap without crashing", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/only</loc></url>
</urlset>`;
    const parsed = parseSitemapXml(xml);
    expect(parsed.urls).toHaveLength(1);
    expect(parsed.urls[0]?.loc).toBe("https://example.com/only");
  });

  it("ignores priority if not a number", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc><priority>not-a-number</priority></url>
</urlset>`;
    const parsed = parseSitemapXml(xml);
    expect(parsed.urls[0]?.priority).toBeUndefined();
  });
});

describe("decodeSitemapPayload", () => {
  it("returns utf8 when not gzipped", async () => {
    const buf = Buffer.from("<urlset/>", "utf8");
    expect(await decodeSitemapPayload(buf)).toBe("<urlset/>");
  });

  it("gunzips when content is gzip-encoded", async () => {
    const original = "<urlset>hello</urlset>";
    const gz = gzipSync(Buffer.from(original, "utf8"));
    expect(await decodeSitemapPayload(gz)).toBe(original);
  });

  it("refuses a gzip payload that decompresses past maxOutputLength (gzip bomb)", async () => {
    // ~10 KB on the wire, 10 MiB inflated: max_bytes alone only bounds the former.
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(64 * 1024);
    await expect(decodeSitemapPayload(bomb, 64 * 1024)).rejects.toThrow(
      /decompresses past 65536 bytes.*raise max_bytes/,
    );
  });

  it("decompresses a payload that fits under maxOutputLength", async () => {
    const original = "<urlset>fits</urlset>";
    const gz = gzipSync(Buffer.from(original, "utf8"));
    expect(await decodeSitemapPayload(gz, original.length)).toBe(original);
  });
});

describe("sitemapByteCap", () => {
  it("defaults to 20 MiB and passes a smaller caller value through", () => {
    expect(sitemapByteCap(undefined)).toBe(20 * 1024 * 1024);
    expect(sitemapByteCap(4096)).toBe(4096);
  });

  it("never exceeds the 100 MiB ceiling, so max_bytes cannot lift the gzip-bomb cap past it", () => {
    // The schema puts no upper bound on max_bytes; this clamp is the bound.
    expect(sitemapByteCap(ABSOLUTE_MAX_BYTES)).toBe(ABSOLUTE_MAX_BYTES);
    expect(sitemapByteCap(ABSOLUTE_MAX_BYTES + 1)).toBe(ABSOLUTE_MAX_BYTES);
    expect(sitemapByteCap(Number.MAX_SAFE_INTEGER)).toBe(ABSOLUTE_MAX_BYTES);
  });
});
