import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";

export interface ExtractedLink {
  href: string;
  text: string;
  rel?: string;
  title?: string;
  type: "internal" | "external";
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

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`]+))/g;
  for (const m of s.matchAll(re)) {
    attrs[m[1]!.toLowerCase()] = decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  // Respect <base href="..."> if present
  const baseTag = html.match(/<base\s+[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"'`]+))/i);
  const baseHref = baseTag ? (baseTag[1] ?? baseTag[2] ?? baseTag[3]) : undefined;
  let base = baseUrl;
  if (baseHref) {
    try {
      base = new URL(baseHref, baseUrl).toString();
    } catch {
      // fall back to baseUrl
    }
  }

  let baseHost: string;
  try {
    baseHost = new URL(base).host;
  } catch {
    baseHost = "";
  }

  const links: ExtractedLink[] = [];
  const re = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = parseAttrs(m[1]!);
    const href = attrs.href;
    if (!href) continue;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith("javascript:") ||
      lower.startsWith("mailto:") ||
      lower.startsWith("tel:") ||
      lower.startsWith("data:") ||
      lower.startsWith("file:")
    )
      continue;

    let abs: string;
    try {
      abs = new URL(trimmed, base).toString();
    } catch {
      continue;
    }

    const text = m[2]!
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    let host: string;
    try {
      host = new URL(abs).host;
    } catch {
      continue;
    }

    const link: ExtractedLink = {
      href: abs,
      text: decodeHtmlEntities(text),
      type: host === baseHost ? "internal" : "external",
    };
    if (attrs.rel) link.rel = attrs.rel;
    if (attrs.title) link.title = attrs.title;
    links.push(link);
  }
  return links;
}

export function registerLinksTools(server: McpServer) {
  server.tool(
    "fetch_links",
    "Extract every outbound link from an HTML page, resolved to absolute URLs. Each entry includes href, anchor text, optional rel/title, and an internal/external classification based on matching the page host. Anchors (#), javascript:, mailto:, tel:, data:, and file: URIs are skipped. Respects <base href>.",
    {
      url: z.string().url(),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      max_bytes: z.number().int().positive().optional(),
      max_redirects: z.number().int().min(0).max(20).optional(),
      allow_private_hosts: z.boolean().optional(),
      user_agent: z.string().optional(),
      dedupe: z.boolean().optional().describe("Drop duplicate hrefs (default true)"),
      filter: z.enum(["all", "internal", "external"]).optional().describe("Filter by type (default 'all')"),
      limit: z.number().int().min(1).max(10_000).optional().describe("Cap on returned links (default 1000)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, timeout_ms, max_bytes, max_redirects, allow_private_hosts, user_agent, dedupe, filter, limit }) => {
      const res = await httpRequest({
        method: "GET",
        url,
        timeoutMs: timeout_ms,
        maxBytes: max_bytes,
        maxRedirects: max_redirects,
        allowPrivateHosts: allow_private_hosts,
        userAgent: user_agent,
        decodeText: true,
      });
      if (res.error) return formatError(res.error);
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText}`);
      if (!res.bodyText) return formatError("empty body");
      let links = extractLinks(res.bodyText, res.url);
      if (filter && filter !== "all") links = links.filter((l) => l.type === filter);
      if (dedupe !== false) {
        const seen = new Set<string>();
        links = links.filter((l) => {
          if (seen.has(l.href)) return false;
          seen.add(l.href);
          return true;
        });
      }
      const cap = limit ?? 1000;
      const truncated = links.length > cap;
      if (truncated) links = links.slice(0, cap);
      return formatJson({ url: res.url, linkCount: links.length, truncated, links });
    },
  );
}
