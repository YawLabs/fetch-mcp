import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";

export interface FeedEntry {
  title?: string;
  link?: string;
  id?: string;
  published?: string;
  updated?: string;
  author?: string;
  summary?: string;
  content?: string;
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

export function parseFeedXml(xml: string): ParsedFeed {
  const parser = new XMLParser({
    ignoreAttributes: false,
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
        const entry: FeedEntry = {
          title: toStr(e.title),
          link: extractAtomLink(e.link),
          id: toStr(e.id),
          published: toStr(e.published),
          updated: toStr(e.updated),
          author: extractAtomAuthor(e.author),
          summary: toStr(e.summary),
          content: toStr(e.content),
        };
        if (cats.length > 0) entry.categories = cats;
        return entry;
      }),
    };
  }

  return { kind: "unknown", entries: [] };
}

export function registerFeedTools(server: McpServer) {
  server.tool(
    "fetch_feed",
    "Fetch and parse an RSS 2.0 or Atom 1.0 feed. Returns feed-level metadata (title, description, link, updated) plus a list of entries (title, link, id, published, updated, author, summary, content, categories). Auto-detects RSS vs Atom.",
    {
      url: z.string().url(),
      limit: z.number().int().min(1).max(500).optional().describe("Max entries to return (default 50)"),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      allow_private_hosts: z.boolean().optional(),
      user_agent: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, limit, timeout_ms, allow_private_hosts, user_agent }) => {
      const res = await httpRequest({
        method: "GET",
        url,
        timeoutMs: timeout_ms,
        maxBytes: 10 * 1024 * 1024,
        allowPrivateHosts: allow_private_hosts,
        userAgent: user_agent,
        decodeText: true,
      });
      if (res.error) return formatError(res.error);
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText}`);
      if (!res.bodyText) return formatError("empty body");
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
