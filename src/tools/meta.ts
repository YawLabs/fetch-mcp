import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";
import { decodeHtmlEntities, findTags, parseAttrs } from "./html.js";

export interface PageMeta {
  url: string;
  title?: string;
  description?: string;
  canonical?: string;
  language?: string;
  robots?: string;
  /** First observed value per key — convenient single-value accessor. */
  og: Record<string, string>;
  twitter: Record<string, string>;
  article: Record<string, string>;
  /** All observed values per key, in source order. Populated for keys that appear more than once. */
  ogAll: Record<string, string[]>;
  twitterAll: Record<string, string[]>;
  articleAll: Record<string, string[]>;
  icons: Array<{ href: string; sizes?: string; rel: string }>;
  feeds: Array<{ href: string; title?: string; type?: string }>;
  jsonLd: unknown[];
}

function collect(dict: Record<string, string>, allDict: Record<string, string[]>, key: string, value: string) {
  if (!(key in dict)) dict[key] = value;
  if (!allDict[key]) allDict[key] = [];
  allDict[key].push(value);
}

/** Reduce the "all" dict to only keys with more than one distinct entry. */
function pruneSingles(all: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(all)) {
    if (v.length > 1) out[k] = v;
  }
  return out;
}

export function parseHtmlMeta(html: string, baseUrl: string): PageMeta {
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;

  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]!.trim().replace(/\s+/g, " ")) : undefined;

  const htmlTagMatch = html.match(/<html\b[^>]*>/i);
  const language = htmlTagMatch ? parseAttrs(htmlTagMatch[0].slice(5, -1)).lang : undefined;

  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const article: Record<string, string> = {};
  const ogAllRaw: Record<string, string[]> = {};
  const twitterAllRaw: Record<string, string[]> = {};
  const articleAllRaw: Record<string, string[]> = {};
  let description: string | undefined;
  let robots: string | undefined;

  for (const tag of findTags(head, "meta")) {
    const attrs = parseAttrs(tag.attrsText);
    const rawName = attrs.property ?? attrs.name ?? attrs.itemprop ?? "";
    const name = rawName.toLowerCase();
    const content = attrs.content;
    if (!name || content === undefined) continue;
    if (name === "description") description = description ?? content;
    else if (name === "robots") robots = robots ?? content;
    else if (name.startsWith("og:")) collect(og, ogAllRaw, name.slice(3), content);
    else if (name.startsWith("twitter:")) collect(twitter, twitterAllRaw, name.slice(8), content);
    else if (name.startsWith("article:")) collect(article, articleAllRaw, name.slice(8), content);
  }

  let canonical: string | undefined;
  const icons: PageMeta["icons"] = [];
  const feeds: PageMeta["feeds"] = [];
  for (const tag of findTags(head, "link")) {
    const attrs = parseAttrs(tag.attrsText);
    const rel = (attrs.rel ?? "").toLowerCase();
    const href = attrs.href;
    if (!href || !rel) continue;
    const abs = resolveUrl(baseUrl, href);
    if (rel === "canonical") canonical = canonical ?? abs;
    if (rel.includes("icon")) {
      const icon: PageMeta["icons"][number] = { rel, href: abs };
      if (attrs.sizes) icon.sizes = attrs.sizes;
      icons.push(icon);
    }
    if (rel === "alternate") {
      const type = attrs.type ?? "";
      if (type.includes("rss") || type.includes("atom") || type.includes("xml") || type.includes("json")) {
        const feed: PageMeta["feeds"][number] = { href: abs };
        if (attrs.title) feed.title = attrs.title;
        if (type) feed.type = type;
        feeds.push(feed);
      }
    }
  }

  const jsonLd: unknown[] = [];
  const jsonLdRe = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(jsonLdRe)) {
    const raw = m[1]!.trim();
    if (!raw) continue;
    try {
      jsonLd.push(JSON.parse(raw));
    } catch {
      // malformed JSON-LD -- skip rather than fail the whole request
    }
  }

  return {
    url: baseUrl,
    title,
    description,
    canonical,
    language,
    robots,
    og,
    twitter,
    article,
    ogAll: pruneSingles(ogAllRaw),
    twitterAll: pruneSingles(twitterAllRaw),
    articleAll: pruneSingles(articleAllRaw),
    icons,
    feeds,
    jsonLd,
  };
}

function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export function registerMetaTools(server: McpServer) {
  server.tool(
    "fetch_meta",
    "GET a URL and extract its head metadata: title, description, canonical, language, robots directive, Open Graph / Twitter Card / article: properties, icon links, RSS/Atom feed links, and any JSON-LD (schema.org) blocks. Keys that appear more than once (e.g. multiple og:image tags) are additionally returned via ogAll/twitterAll/articleAll arrays. Ideal for previewing a page before fully reading it.",
    {
      url: z.string().url().describe("URL to extract metadata from"),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      max_bytes: z.number().int().positive().optional().describe("Default 2MiB — metadata lives in <head>"),
      max_redirects: z.number().int().min(0).max(20).optional(),
      allow_private_hosts: z.boolean().optional(),
      user_agent: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, timeout_ms, max_bytes, max_redirects, allow_private_hosts, user_agent }) => {
      const res = await httpRequest({
        method: "GET",
        url,
        timeoutMs: timeout_ms,
        maxBytes: max_bytes ?? 2 * 1024 * 1024,
        maxRedirects: max_redirects,
        allowPrivateHosts: allow_private_hosts,
        userAgent: user_agent,
        decodeText: true,
      });
      if (res.error) return formatError(res.error);
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText}`);
      if (!res.bodyText) return formatError("empty body");
      return formatJson(parseHtmlMeta(res.bodyText, res.url));
    },
  );
}
