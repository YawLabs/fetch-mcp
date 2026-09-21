import { createGunzip } from "node:zlib";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { ABSOLUTE_MAX_BYTES, httpRequest } from "../http.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";

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

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The per-sitemap byte budget: the caller's `max_bytes` (default 20 MiB),
 * never above the 100 MiB ceiling `httpRequest()` applies to the wire read.
 * One number bounds both the compressed bytes read off the wire and the
 * DECOMPRESSED size of a gzipped payload, so a model-chosen `max_bytes` cannot
 * lift the gzip-bomb cap past the ceiling.
 */
export function sitemapByteCap(maxBytes: number | undefined): number {
  return Math.min(maxBytes ?? DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES);
}

/**
 * Decode a sitemap byte payload. Many sitemaps are served gzipped, either via
 * Content-Encoding (which node fetch unwraps) or as a .xml.gz file served with
 * application/x-gzip (which fetch leaves alone). We detect the gzip magic and
 * decompress manually if needed.
 *
 * `maxOutputLength` caps the DECOMPRESSED size. `max_bytes` only bounds the
 * compressed bytes read off the wire, and gzip reaches ~1000:1 on repetitive
 * input, so without a cap a 200 KB response inflates to ~200 MB (a gzip bomb
 * past max_bytes) and takes the server down.
 *
 * The cap is counted by hand on a streaming gunzip rather than passed as
 * zlib's `maxOutputLength`: oam (the launcher's preferred runtime) accepts
 * that option and ignores it. The compressed input is fed in 1 KiB slices
 * because oam inflates each written slice into a single output chunk, so the
 * slice size bounds how far past the cap one chunk can land (~1 MiB) before
 * the stream is destroyed. Node emits 16 KiB chunks either way.
 */
export async function decodeSitemapPayload(buf: Buffer, maxOutputLength?: number): Promise<string> {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return (await gunzipCapped(buf, maxOutputLength ?? Number.POSITIVE_INFINITY)).toString("utf8");
  }
  return buf.toString("utf8");
}

const GUNZIP_SLICE_BYTES = 1024;

async function gunzipCapped(buf: Buffer, cap: number): Promise<Buffer> {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let total = 0;
  const finished = new Promise<void>((resolve, reject) => {
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        gunzip.destroy(
          new Error(`gzipped sitemap decompresses past ${cap} bytes (the max_bytes cap); raise max_bytes to read it`),
        );
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("error", reject);
    gunzip.on("end", resolve);
  });
  // The rejection can land while the write loop below is still running; keep
  // it from being reported as unhandled before the await at the bottom.
  finished.catch(() => {});

  for (let offset = 0; offset < buf.length && !gunzip.destroyed; offset += GUNZIP_SLICE_BYTES) {
    gunzip.write(buf.subarray(offset, offset + GUNZIP_SLICE_BYTES));
    // Let the inflater run and the byte count catch up before the next slice.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!gunzip.destroyed) gunzip.end();
  await finished;
  return Buffer.concat(chunks, total);
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

interface SitemapWarning {
  url: string;
  error: string;
}

export function registerSitemapTools(server: McpServer) {
  server.tool(
    "fetch_sitemap",
    "Fetch a sitemap.xml (or sitemap-index) and return the contained URLs with their lastmod / changefreq / priority. Follows sitemap-index chaining up to max_depth levels. Gzipped .xml.gz payloads are auto-decompressed. Partial failures (one child sitemap 500s while others work) are returned under 'warnings' without aborting the whole request. SSRF-protected by default.",
    {
      url: z.string().url().describe("Sitemap URL (sitemap.xml, sitemap.xml.gz, or a sitemap index)"),
      max_depth: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe(
          "How many sitemap-index levels to follow (default 1). 0 keeps the top-level index flat and only returns its childSitemaps list.",
        ),
      max_urls: z.number().int().min(1).max(50_000).optional().describe("Cap on total URLs returned (default 5000)"),
      max_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max bytes to read per sitemap response (default 20MiB)"),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      max_redirects: z.number().int().min(0).max(20).optional(),
      allow_private_hosts: z.boolean().optional().describe(ALLOW_PRIVATE_HOSTS_DESCRIPTION),
      user_agent: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, max_depth, max_urls, max_bytes, timeout_ms, max_redirects, allow_private_hosts, user_agent }) => {
      const depth = max_depth ?? 1;
      const cap = max_urls ?? 5000;
      const byteCap = sitemapByteCap(max_bytes);
      const seen = new Set<string>();
      const allUrls: SitemapUrl[] = [];
      const visitedIndexes: string[] = [];
      const unvisitedChildren: string[] = [];
      const warnings: SitemapWarning[] = [];

      const fetchOne = async (
        u: string,
      ): Promise<{ ok: true; parsed: ParsedSitemap } | { ok: false; error: string }> => {
        const res = await httpRequest({
          method: "GET",
          url: u,
          timeoutMs: timeout_ms,
          maxBytes: byteCap,
          maxRedirects: max_redirects,
          allowPrivateHosts: allow_private_hosts,
          userAgent: user_agent,
          decodeText: false,
        });
        if (res.error) return { ok: false, error: res.error };
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
        if (!res.bodyBase64) return { ok: false, error: "empty body" };
        const buf = Buffer.from(res.bodyBase64, "base64");
        try {
          const xml = await decodeSitemapPayload(buf, byteCap);
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
        if (!result.ok) {
          // If the very first fetch fails, the whole tool is meaningless -- surface as error.
          if (visitedIndexes.length === 0 && allUrls.length === 0) {
            return formatError(`${next.url}: ${result.error}`);
          }
          warnings.push({ url: next.url, error: result.error });
          continue;
        }
        visitedIndexes.push(next.url);
        for (const child of result.parsed.urls) {
          if (allUrls.length >= cap) break;
          allUrls.push(child);
        }
        for (const c of result.parsed.childSitemaps) {
          if (seen.has(c)) continue;
          if (next.depth < depth) {
            queue.push({ url: c, depth: next.depth + 1 });
          } else {
            unvisitedChildren.push(c);
          }
        }
      }
      return formatJson({
        sitemaps: visitedIndexes,
        urlCount: allUrls.length,
        truncated: allUrls.length >= cap,
        urls: allUrls,
        childSitemaps: unvisitedChildren,
        warnings,
      });
    },
  );
}
