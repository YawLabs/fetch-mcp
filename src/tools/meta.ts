import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";

export interface PageMeta {
  url: string;
  title?: string;
  description?: string;
  canonical?: string;
  language?: string;
  robots?: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
  article: Record<string, string>;
  icons: Array<{ href: string; sizes?: string; rel: string }>;
  feeds: Array<{ href: string; title?: string; type?: string }>;
  jsonLd: unknown[];
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => {
      const n = Number.parseInt(h, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#(\d+);/g, (_, d: string) => {
      const n = Number.parseInt(d, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
}

function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`]+))/g;
  for (const m of s.matchAll(re)) {
    attrs[m[1]!.toLowerCase()] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

export function parseHtmlMeta(html: string, baseUrl: string): PageMeta {
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;

  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]!.trim().replace(/\s+/g, " ")) : undefined;

  const htmlTagMatch = html.match(/<html\b[^>]*>/i);
  const language = htmlTagMatch ? parseAttrs(htmlTagMatch[0]).lang : undefined;

  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const article: Record<string, string> = {};
  let description: string | undefined;
  let robots: string | undefined;

  const metaRe = /<meta\s+([^>]+?)\/?>/gi;
  for (const m of head.matchAll(metaRe)) {
    const attrs = parseAttrs(m[1]!);
    const name = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").toLowerCase();
    const content = attrs.content;
    if (!name || content === undefined) continue;
    if (name === "description") description = content;
    else if (name === "robots") robots = content;
    else if (name.startsWith("og:")) og[name.slice(3)] = content;
    else if (name.startsWith("twitter:")) twitter[name.slice(8)] = content;
    else if (name.startsWith("article:")) article[name.slice(8)] = content;
  }

  let canonical: string | undefined;
  const icons: PageMeta["icons"] = [];
  const feeds: PageMeta["feeds"] = [];
  const linkRe = /<link\s+([^>]+?)\/?>/gi;
  for (const m of head.matchAll(linkRe)) {
    const attrs = parseAttrs(m[1]!);
    const rel = (attrs.rel ?? "").toLowerCase();
    const href = attrs.href;
    if (!href || !rel) continue;
    const abs = resolveUrl(baseUrl, href);
    if (rel === "canonical") canonical = abs;
    if (rel.includes("icon")) icons.push({ rel, href: abs, sizes: attrs.sizes });
    if (rel === "alternate") {
      const type = attrs.type ?? "";
      if (type.includes("rss") || type.includes("atom") || type.includes("xml") || type.includes("json")) {
        feeds.push({ href: abs, title: attrs.title, type });
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
      // malformed JSON-LD — skip rather than fail the whole request
    }
  }

  return { url: baseUrl, title, description, canonical, language, robots, og, twitter, article, icons, feeds, jsonLd };
}

export function registerMetaTools(server: McpServer) {
  server.tool(
    "fetch_meta",
    "GET a URL and extract its head metadata: title, description, canonical, language, robots directive, Open Graph / Twitter Card / article: properties, icon links, RSS/Atom feed links, and any JSON-LD (schema.org) blocks. Ideal for previewing a page before fully reading it — typical response is 1–3KB.",
    {
      url: z.string().url().describe("URL to extract metadata from"),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      max_bytes: z.number().int().positive().optional().describe("Default 2MiB — metadata lives in <head>"),
      allow_private_hosts: z.boolean().optional(),
      user_agent: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, timeout_ms, max_bytes, allow_private_hosts, user_agent }) => {
      const res = await httpRequest({
        method: "GET",
        url,
        timeoutMs: timeout_ms,
        maxBytes: max_bytes ?? 2 * 1024 * 1024,
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
