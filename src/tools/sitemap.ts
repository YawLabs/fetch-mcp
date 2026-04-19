import { gunzipSync } from "node:zlib";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface ParsedSitemap {
  urls: SitemapUrl[];
  childSitemaps: string[];
}

/**
 * Decode a sitemap byte payload. Many sitemaps are served gzipped, either via
 * Content-Encoding (which node fetch unwraps) or as a .xml.gz file served with
 * application/x-gzip (which fetch leaves alone). We detect the gzip magic and
 * decompress manually if needed.
 */
export function decodeSitemapPayload(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf).toString("utf8");
  }
  return buf.toString("utf8");
}

export function parseSitemapXml(xml: string): ParsedSitemap {
  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
    parseTagValue: false,
    isArray: (name) => name === "url" || name === "sitemap",
  });
  const doc = parser.parse(xml) as {
    urlset?: { url?: Array<{ loc?: string; lastmod?: string; changefreq?: string; priority?: string | number }> };
    sitemapindex?: { sitemap?: Array<{ loc?: string; lastmod?: string }> };
  };
  const urls: SitemapUrl[] = [];
  const childSitemaps: string[] = [];

  if (doc.urlset?.url) {
    for (const u of doc.urlset.url) {
      if (!u.loc) continue;
      const entry: SitemapUrl = { loc: String(u.loc).trim() };
      if (u.lastmod) entry.lastmod = String(u.lastmod).trim();
      if (u.changefreq) entry.changefreq = String(u.changefreq).trim();
      if (u.priority !== undefined) {
        const p = Number.parseFloat(String(u.priority));
        if (Number.isFinite(p)) entry.priority = p;
      }
      urls.push(entry);
    }
  }
  if (doc.sitemapindex?.sitemap) {
    for (const s of doc.sitemapindex.sitemap) {
      if (s.loc) childSitemaps.push(String(s.loc).trim());
    }
  }
  return { urls, childSitemaps };
}

export function registerSitemapTools(server: McpServer) {
  server.tool(
    "fetch_sitemap",
    "Fetch a sitemap.xml (or sitemap-index) and return the contained URLs with their lastmod / changefreq / priority. Follows sitemap-index chaining up to max_depth levels. Gzipped .xml.gz payloads are auto-decompressed. SSRF-protected by default.",
    {
      url: z.string().url().describe("Sitemap URL (sitemap.xml, sitemap.xml.gz, or a sitemap index)"),
      max_depth: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe("How many sitemap-index levels to follow (default 1)"),
      max_urls: z.number().int().min(1).max(50_000).optional().describe("Cap on total URLs returned (default 5000)"),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      allow_private_hosts: z.boolean().optional(),
      user_agent: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, max_depth, max_urls, timeout_ms, allow_private_hosts, user_agent }) => {
      const depth = max_depth ?? 1;
      const cap = max_urls ?? 5000;
      const seen = new Set<string>();
      const allUrls: SitemapUrl[] = [];
      const visitedIndexes: string[] = [];

      const fetchOne = async (
        u: string,
      ): Promise<{ ok: true; parsed: ParsedSitemap } | { ok: false; error: string }> => {
        const res = await httpRequest({
          method: "GET",
          url: u,
          timeoutMs: timeout_ms,
          maxBytes: 20 * 1024 * 1024,
          allowPrivateHosts: allow_private_hosts,
          userAgent: user_agent,
          decodeText: false,
        });
        if (res.error) return { ok: false, error: res.error };
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
        if (!res.bodyBase64) return { ok: false, error: "empty body" };
        const buf = Buffer.from(res.bodyBase64, "base64");
        try {
          const xml = decodeSitemapPayload(buf);
          return { ok: true, parsed: parseSitemapXml(xml) };
        } catch (err) {
          return { ok: false, error: `parse failed: ${(err as Error).message}` };
        }
      };

      const queue: Array<{ url: string; depth: number }> = [{ url, depth: 0 }];
      while (queue.length > 0 && allUrls.length < cap) {
        const next = queue.shift();
        if (!next) break;
        if (seen.has(next.url)) continue;
        seen.add(next.url);
        const result = await fetchOne(next.url);
        if (!result.ok) return formatError(`${next.url}: ${result.error}`);
        visitedIndexes.push(next.url);
        for (const child of result.parsed.urls) {
          if (allUrls.length >= cap) break;
          allUrls.push(child);
        }
        if (next.depth < depth) {
          for (const c of result.parsed.childSitemaps) {
            if (!seen.has(c)) queue.push({ url: c, depth: next.depth + 1 });
          }
        }
      }
      return formatJson({
        sitemaps: visitedIndexes,
        urlCount: allUrls.length,
        truncated: allUrls.length >= cap,
        urls: allUrls,
      });
    },
  );
}
