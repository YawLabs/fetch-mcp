import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { ABSOLUTE_MAX_BYTES, CANCELLED, type HttpRequester } from "../http.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";
import { assertXmlTagCount } from "./sitemap.js";

export interface FeedEntry {
  title?: string;
  link?: string;
  id?: string;
  published?: string;
  updated?: string;
  author?: string;
  summary?: string;
  content?: string;
  /** Atom content type (text / html / xhtml) when declared. */
  contentType?: string;
  categories?: string[];
}

export interface ParsedFeed {
  kind: "rss" | "atom" | "unknown";
  title?: string;
  description?: string;
  link?: string;
  updated?: string;
  entries: FeedEntry[];
}

function toStr(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    return t || undefined;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["#text"] === "string") return (o["#text"] as string).trim() || undefined;
    if (typeof o["@_href"] === "string") return (o["@_href"] as string).trim() || undefined;
  }
  return undefined;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function extractAtomLink(link: unknown): string | undefined {
  const list = toArray(link);
  if (list.length === 0) return undefined;
  // Prefer rel="alternate" or no rel; avoid rel="self"
  let fallback: string | undefined;
  for (const l of list) {
    if (typeof l === "string") {
      fallback = fallback ?? l.trim();
      continue;
    }
    if (l && typeof l === "object") {
      const o = l as Record<string, unknown>;
      const rel = typeof o["@_rel"] === "string" ? (o["@_rel"] as string).toLowerCase() : undefined;
      const href = typeof o["@_href"] === "string" ? (o["@_href"] as string) : undefined;
      if (!href) continue;
      if (!rel || rel === "alternate") return href;
      if (rel !== "self" && rel !== "hub" && rel !== "enclosure") fallback = fallback ?? href;
    }
  }
  return fallback;
}

function extractAtomContent(content: unknown): { value?: string; type?: string } {
  if (typeof content === "string") return { value: content.trim() || undefined };
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    const type = typeof o["@_type"] === "string" ? (o["@_type"] as string) : undefined;
    const value = toStr(o);
    const out: { value?: string; type?: string } = {};
    if (value) out.value = value;
    if (type) out.type = type;
    return out;
  }
  return {};
}

function extractAtomAuthor(author: unknown): string | undefined {
  const list = toArray(author);
  if (list.length === 0) return undefined;
  const first = list[0];
  if (typeof first === "string") return first.trim() || undefined;
  if (first && typeof first === "object") {
    const o = first as Record<string, unknown>;
    return toStr(o.name) ?? toStr(o.email) ?? toStr(o);
  }
  return undefined;
}

/**
 * The largest feed body handed to the XML parser, in UTF-16 units of the
 * decoded text. fast-xml-parser runs synchronously on the whole string and
 * cannot be interrupted: through 0.8.3 a 9 MiB RSS stalled the stdio server
 * 2.2 s (282 MB), and `max_bytes` goes up to 100 MiB. Text-heavy shapes cost
 * ~0.15-0.3 s per MiB; markup costs per tag, so 16 MiB of `<x/>` took 7.6 s
 * until `MAX_FEED_PARSE_TAGS` also bounded it. Together they hold one parse
 * to ~3 s (measured <=2.8 s). The default `max_bytes`
 * (10 MiB) stays under it; a caller who raises `max_bytes` past it gets an
 * error naming this limit for a larger feed.
 */
export const MAX_FEED_PARSE_BYTES = 16 * 1024 * 1024;

/** The most `<` a feed may hold before it is parsed; 16 MiB of ordinary RSS items has ~200,000. */
export const MAX_FEED_PARSE_TAGS = 1_000_000;

/** Attributes the extractors below read; the parser drops every other one. */
const FEED_ATTRIBUTES = new Set(["href", "rel", "type", "term", "label"]);

function feedParseLimitMessage(limit: number): string {
  return `feed is larger than the ${limit}-byte parse limit; larger feeds are refused`;
}

/**
 * Parse an RSS 2.0 or Atom 1.0 document. Refuses input past `parseLimit`
 * (default `MAX_FEED_PARSE_BYTES`). Only the attributes in `FEED_ATTRIBUTES`
 * are kept: an element with many distinct attribute names is the parser's
 * slowest shape (~1 s per MiB kept, ~0.25 s with the allow-list). fast-xml-
 * parser's defaults bound the rest, and the tool reports the throw: DOCTYPE
 * entities (count, size, 100,000 expanded characters in all, references
 * between entities not expanded) and nesting (100 levels).
 */
export function parseFeedXml(xml: string, parseLimit: number = MAX_FEED_PARSE_BYTES): ParsedFeed {
  if (xml.length > parseLimit) throw new Error(feedParseLimitMessage(parseLimit));
  assertXmlTagCount(xml, MAX_FEED_PARSE_TAGS, "feed");
  const parser = new XMLParser({
    ignoreAttributes: (name: string) => !FEED_ATTRIBUTES.has(name),
    trimValues: true,
    parseTagValue: false,
    processEntities: true,
    htmlEntities: true,
  });
  const doc = parser.parse(xml) as Record<string, unknown>;

  if (doc.rss && typeof doc.rss === "object") {
    const rss = doc.rss as Record<string, unknown>;
    const channel = (rss.channel ?? {}) as Record<string, unknown>;
    const items = toArray(channel.item) as Record<string, unknown>[];
    return {
      kind: "rss",
      title: toStr(channel.title),
      description: toStr(channel.description),
      link: toStr(channel.link),
      updated: toStr(channel.lastBuildDate) ?? toStr(channel.pubDate),
      entries: items.map((i) => {
        const cats = toArray(i.category)
          .map((c) => toStr(c))
          .filter((s): s is string => !!s);
        const entry: FeedEntry = {
          title: toStr(i.title),
          link: toStr(i.link),
          id: toStr(i.guid),
          published: toStr(i.pubDate),
          author: toStr(i.author) ?? toStr(i["dc:creator"]),
          summary: toStr(i.description),
          content: toStr(i["content:encoded"]),
        };
        if (cats.length > 0) entry.categories = cats;
        return entry;
      }),
    };
  }

  if (doc.feed && typeof doc.feed === "object") {
    const feed = doc.feed as Record<string, unknown>;
    const entries = toArray(feed.entry) as Record<string, unknown>[];
    return {
      kind: "atom",
      title: toStr(feed.title),
      description: toStr(feed.subtitle),
      link: extractAtomLink(feed.link),
      updated: toStr(feed.updated),
      entries: entries.map((e) => {
        const cats = toArray(e.category)
          .map((c) => {
            if (typeof c === "object" && c !== null) {
              const o = c as Record<string, unknown>;
              return toStr(o["@_term"]) ?? toStr(o["@_label"]);
            }
            return toStr(c);
          })
          .filter((s): s is string => !!s);
        const { value: contentValue, type: contentType } = extractAtomContent(e.content);
        const entry: FeedEntry = {
          title: toStr(e.title),
          link: extractAtomLink(e.link),
          id: toStr(e.id),
          published: toStr(e.published),
          updated: toStr(e.updated),
          author: extractAtomAuthor(e.author),
          summary: toStr(e.summary),
          content: contentValue,
        };
        if (contentType) entry.contentType = contentType;
        if (cats.length > 0) entry.categories = cats;
        return entry;
      }),
    };
  }

  return { kind: "unknown", entries: [] };
}

export function registerFeedTools(server: McpServer, request: HttpRequester) {
  server.tool(
    "fetch_feed",
    "Fetch and parse an RSS 2.0 or Atom 1.0 feed. Returns feed-level metadata (title, description, link, updated) plus a list of entries (title, link, id, published, updated, author, summary, content, contentType, categories). Auto-detects RSS vs Atom.",
    {
      url: z.string().url(),
      limit: z.number().int().min(1).max(500).optional().describe("Max entries to return (default 50)"),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      max_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max bytes to read (default 10MiB). A feed over 16 MiB is refused whatever max_bytes says."),
      max_redirects: z.number().int().min(0).max(20).optional(),
      allow_private_hosts: z.boolean().optional().describe(ALLOW_PRIVATE_HOSTS_DESCRIPTION),
      user_agent: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, limit, timeout_ms, max_bytes, max_redirects, allow_private_hosts, user_agent }, extra) => {
      const maxBytes = Math.min(max_bytes ?? 10 * 1024 * 1024, ABSOLUTE_MAX_BYTES);
      const res = await request({
        signal: extra.signal,
        method: "GET",
        url,
        timeoutMs: timeout_ms,
        maxBytes,
        maxRedirects: max_redirects,
        allowPrivateHosts: allow_private_hosts,
        userAgent: user_agent,
        decodeText: true,
      });
      if (res.error) return formatError(res.error);
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText}`);
      // A body cut off at max_bytes is partial XML: say so rather than
      // surfacing the parser's "tag is not closed" complaint.
      if (res.truncated) {
        return formatError(`feed is larger than max_bytes (${maxBytes} bytes); raise max_bytes to read it`);
      }
      if (!res.bodyText) return formatError("empty body");
      if (res.bodyText.length > MAX_FEED_PARSE_BYTES) return formatError(feedParseLimitMessage(MAX_FEED_PARSE_BYTES));
      // The parse is synchronous and cannot be interrupted; do not start one
      // for a request the client has already cancelled.
      if (extra.signal.aborted) return formatError(CANCELLED);
      try {
        const feed = parseFeedXml(res.bodyText);
        const cap = limit ?? 50;
        return formatJson({
          ...feed,
          entryCount: feed.entries.length,
          truncated: feed.entries.length > cap,
          entries: feed.entries.slice(0, cap),
        });
      } catch (err) {
        return formatError(`feed parse failed: ${(err as Error).message}`);
      }
    },
  );
}
