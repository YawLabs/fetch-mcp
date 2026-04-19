import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeSitemapPayload, parseSitemapXml } from "../tools/sitemap.js";

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
  it("returns utf8 when not gzipped", () => {
    const buf = Buffer.from("<urlset/>", "utf8");
    expect(decodeSitemapPayload(buf)).toBe("<urlset/>");
  });

  it("gunzips when content is gzip-encoded", () => {
    const original = "<urlset>hello</urlset>";
    const gz = gzipSync(Buffer.from(original, "utf8"));
    expect(decodeSitemapPayload(gz)).toBe(original);
  });
});
