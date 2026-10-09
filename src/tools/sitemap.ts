import { createGunzip } from "node:zlib";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { ABSOLUTE_MAX_BYTES, ABSOLUTE_MAX_TOTAL_MS, CANCELLED, type HttpRequester } from "../http.js";
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
const DEFAULT_MAX_SITEMAPS = 50;
const MAX_SITEMAPS_CEILING = 1000;

/**
 * The largest decoded sitemap document handed to the XML parser. fast-xml-parser
 * runs synchronously on the whole string and cannot be interrupted: through
 * 0.8.3 a 19 MiB urlset stalled the stdio server 4.65 s (512 MB), and at the
 * 100 MiB `max_bytes` ceiling one parse would stall ~20-25 s, uncancellable.
 * Text-heavy shapes (numeric character references, image-extension urlsets)
 * cost ~0.15-0.3 s per MiB; markup costs per tag (~1.5-1.8 us each), so 16 MiB of
 * `<a/>` took 6-7.5 s until `MAX_XML_PARSE_TAGS` below also bounded it.
 * Together they hold one parse to ~3 s (measured <=2.8 s). A protocol-sized sitemap (50,000 URLs with lastmod /
 * changefreq / priority, ~10.6 MiB) fits; a larger single document -- e.g.
 * 50,000 URLs each carrying two image:image entries, ~21 MiB -- is refused with
 * an error naming this limit, and raising `max_bytes` does not lift it. Plain
 * and gzipped payloads alike: the gunzip stops at the smaller of this and the
 * `max_bytes` cap.
 */
export const MAX_XML_PARSE_BYTES = 16 * 1024 * 1024;

/**
 * The most `<` (tags, comments, CDATA, declarations) a sitemap document may
 * hold before it is parsed. A 50,000-URL urlset with lastmod / changefreq /
 * priority has ~500,000.
 */
export const MAX_XML_PARSE_TAGS = 1_500_000;

/**
 * Throws when `xml` holds more than `maxTags` `<` characters. One native
 * `indexOf` walk, a few ms at 16 MiB; run before the synchronous parse,
 * whose cost on markup-dense input follows the tag count, not the length.
 */
export function assertXmlTagCount(xml: string, maxTags: number, what: string): void {
  let n = 0;
  for (let i = xml.indexOf("<"); i >= 0; i = xml.indexOf("<", i + 1)) {
    if (++n > maxTags) throw new Error(`${what} has more than ${maxTags} tags; larger documents are refused`);
  }
}

function parseLimitMessage(limit: number): string {
  return `sitemap XML is larger than the ${limit}-byte parse limit per document; larger documents are refused`;
}

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
 * The cap is counted by hand because the gunzip is a STREAM, and streaming
 * zlib has no `maxOutputLength` cap on Node or on oam: only the one-shot
 * functions (`gunzip`, `gunzipSync`, ...) enforce that option, on both
 * runtimes since oam 0.17.0 (before it, oam ignored it there too). Streaming
 * is what lets `signal` and the cap land between slices instead of after the
 * whole payload has inflated. The compressed input is fed in 1 KiB slices
 * because oam inflates each written slice into a single output chunk
 * (re-measured on oam 0.18.0), so the slice size bounds how far past the cap
 * one chunk can land (~1 MiB) before the stream is destroyed. Node emits
 * 16 KiB chunks either way.
 *
 * `parseLimit` (default `MAX_XML_PARSE_BYTES`) refuses a document the parser
 * would stall on, plain or gzipped; the gunzip stops at whichever cap is
 * smaller, and the error names that cap. `signal` stops the gunzip between
 * slices.
 */
export async function decodeSitemapPayload(
  buf: Buffer,
  maxOutputLength?: number,
  options: { signal?: AbortSignal; parseLimit?: number } = {},
): Promise<string> {
  const parseLimit = options.parseLimit ?? MAX_XML_PARSE_BYTES;
  const byteCap = maxOutputLength ?? Number.POSITIVE_INFINITY;
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const overCap =
      parseLimit < byteCap
        ? parseLimitMessage(parseLimit)
        : `gzipped sitemap decompresses past ${byteCap} bytes (the max_bytes cap); raise max_bytes to read it`;
    return (await gunzipCapped(buf, Math.min(byteCap, parseLimit), overCap, options.signal)).toString("utf8");
  }
  if (buf.length > parseLimit) throw new Error(parseLimitMessage(parseLimit));
  return buf.toString("utf8");
}

const GUNZIP_SLICE_BYTES = 1024;

async function gunzipCapped(buf: Buffer, cap: number, overCap: string, signal?: AbortSignal): Promise<Buffer> {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let total = 0;
  const finished = new Promise<void>((resolve, reject) => {
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        gunzip.destroy(new Error(overCap));
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
    if (signal?.aborted) {
      gunzip.destroy(new Error(CANCELLED));
      break;
    }
    gunzip.write(buf.subarray(offset, offset + GUNZIP_SLICE_BYTES));
    // Let the inflater run and the byte count catch up before the next slice.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!gunzip.destroyed) gunzip.end();
  await finished;
  return Buffer.concat(chunks, total);
}

/**
 * Parse one sitemap document. Refuses input past `parseLimit` UTF-16 units
 * (default `MAX_XML_PARSE_BYTES`; a string decoded from N UTF-8 bytes is at
 * most N units, so a payload `decodeSitemapPayload()` accepted always passes).
 *
 * Attributes are ignored: nothing below reads one, and an element with many
 * distinct attribute names is the parser's slowest shape (~1 s per MiB kept,
 * ~0.01 s ignored). It also keeps `<loc foo="x">url</loc>` a string rather
 * than an object. fast-xml-parser's defaults bound the rest, and the caller
 * reports the throw: DOCTYPE entities (count, size, 100,000 expanded
 * characters in all, references between entities not expanded) and nesting
 * (100 levels).
 */
export function parseSitemapXml(xml: string, parseLimit: number = MAX_XML_PARSE_BYTES): ParsedSitemap {
  if (xml.length > parseLimit) throw new Error(parseLimitMessage(parseLimit));
  assertXmlTagCount(xml, MAX_XML_PARSE_TAGS, "sitemap");
  const parser = new XMLParser({
    ignoreAttributes: true,
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

export interface SitemapLimits {
  /**
   * Budget for one whole fetch_sitemap call, across every document it fetches.
   * Defaults to the ceiling a single httpRequest() call has. Injected rather
   * than module state so a test can shorten it without touching other servers.
   */
  totalMs: number;
  /** Per-document XML parse limit; defaults to `MAX_XML_PARSE_BYTES`. Injected for tests. */
  maxParseBytes?: number;
}

export function registerSitemapTools(
  server: McpServer,
  request: HttpRequester,
  limits: SitemapLimits = { totalMs: ABSOLUTE_MAX_TOTAL_MS },
) {
  server.tool(
    "fetch_sitemap",
    "Fetch a sitemap.xml (or sitemap-index) and return the contained URLs with their lastmod / changefreq / priority. Follows sitemap-index chaining up to max_depth levels. Gzipped .xml.gz payloads are auto-decompressed. A single sitemap document over 16 MiB once decoded is refused (a 50,000-URL sitemap is ~11 MiB). Partial failures (one child sitemap 500s while others work) are returned under 'warnings' without aborting the whole request. SSRF-protected by default.",
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
      max_sitemaps: z
        .number()
        .int()
        .min(1)
        .max(MAX_SITEMAPS_CEILING)
        .optional()
        .describe(
          `Cap on sitemap documents fetched -- the index plus every child (default ${DEFAULT_MAX_SITEMAPS}, max ${MAX_SITEMAPS_CEILING}). Children past the cap are listed under childSitemaps, unfetched.`,
        ),
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
    async (
      { url, max_depth, max_urls, max_sitemaps, max_bytes, timeout_ms, max_redirects, allow_private_hosts, user_agent },
      extra,
    ) => {
      const depth = max_depth ?? 1;
      const cap = max_urls ?? 5000;
      const sitemapCap = max_sitemaps ?? DEFAULT_MAX_SITEMAPS;
      const byteCap = sitemapByteCap(max_bytes);
      const parseLimit = limits.maxParseBytes ?? MAX_XML_PARSE_BYTES;
      let fetched = 0;
      const seen = new Set<string>();
      const allUrls: SitemapUrl[] = [];
      const visitedIndexes: string[] = [];
      const unvisitedChildren: string[] = [];
      const warnings: SitemapWarning[] = [];

      // One budget for the whole tool call. Each fetch is its own httpRequest
      // with its own ceiling, so up to max_sitemaps x timeout_ms could pass
      // before this call returned. `budget` aborts on the MCP request's
      // cancellation or when limits.totalMs runs out, and every fetch -- the
      // one in flight included -- carries its signal.
      const budget = new AbortController();
      let budgetSpent = false;
      const budgetMessage = `fetch_sitemap exceeded its ${limits.totalMs}ms total limit`;
      const onCancel = () => budget.abort();
      if (extra.signal.aborted) budget.abort();
      else extra.signal.addEventListener("abort", onCancel, { once: true });
      const budgetTimer = setTimeout(() => {
        budgetSpent = true;
        budget.abort();
      }, limits.totalMs);

      const fetchOne = async (
        u: string,
      ): Promise<{ ok: true; parsed: ParsedSitemap } | { ok: false; error: string }> => {
        const res = await request({
          signal: budget.signal,
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
        // A body cut off at max_bytes is partial XML. The parser accepts it and
        // returns however many <url> entries arrived, which read as the whole
        // sitemap. Refuse it, the same way an over-cap gzip payload is refused.
        if (res.truncated) {
          return {
            ok: false,
            error: `sitemap is larger than max_bytes (${byteCap} bytes); raise max_bytes to read it`,
          };
        }
        if (!res.bodyBase64) return { ok: false, error: "empty body" };
        const buf = Buffer.from(res.bodyBase64, "base64");
        try {
          const xml = await decodeSitemapPayload(buf, byteCap, { signal: budget.signal, parseLimit });
          // The parse is synchronous and cannot be interrupted, so check the
          // budget and the cancellation right before it: a spent budget is
          // overrun by at most the one parse already running (~3 s at the
          // parse limit), never by another document's. The loop reports a
          // spent budget as the budget message, not as CANCELLED.
          if (budget.signal.aborted) return { ok: false, error: CANCELLED };
          return { ok: true, parsed: parseSitemapXml(xml, parseLimit) };
        } catch (err) {
          return { ok: false, error: `parse failed: ${(err as Error).message}` };
        }
      };

      const queue: Array<{ url: string; depth: number }> = [{ url, depth: 0 }];
      /** Move everything still queued (and unseen) to childSitemaps, once, with a warning. */
      const listUnfetched = (pending: Array<{ url: string }>, why: string) => {
        const distinct = [...new Set(pending.map((q) => q.url).filter((u) => !seen.has(u)))];
        unvisitedChildren.push(...distinct);
        warnings.push({
          url,
          error: `${why}: ${distinct.length} child sitemap(s) not fetched, listed under childSitemaps`,
        });
      };
      try {
        while (queue.length > 0 && allUrls.length < cap) {
          const next = queue.shift();
          if (!next) break;
          if (seen.has(next.url)) continue;
          if (budget.signal.aborted) {
            // Out of budget: say so and list what is left. A plain cancellation
            // just stops -- nobody is waiting for the answer.
            if (budgetSpent) listUnfetched([next, ...queue], budgetMessage);
            break;
          }
          // Bound the fan-out: an index can list hundreds of thousands of child
          // sitemaps on as many hosts, and each one is a request this server makes.
          if (fetched >= sitemapCap) {
            listUnfetched([next, ...queue], `max_sitemaps (${sitemapCap}) reached`);
            break;
          }
          seen.add(next.url);
          fetched++;
          const result = await fetchOne(next.url);
          if (!result.ok) {
            // A fetch cut short by the budget reports why, not "cancelled".
            const error = budgetSpent ? budgetMessage : result.error;
            // If the very first fetch fails, the whole tool is meaningless -- surface as error.
            if (visitedIndexes.length === 0 && allUrls.length === 0) {
              return formatError(`${next.url}: ${error}`);
            }
            warnings.push({ url: next.url, error });
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
      } finally {
        clearTimeout(budgetTimer);
        extra.signal.removeEventListener("abort", onCancel);
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
