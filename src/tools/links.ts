import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";
import { decodeHtmlEntities, findTags, parseAttrs } from "./html.js";

export interface ExtractedLink {
  href: string;
  text: string;
  rel?: string;
  title?: string;
  type: "internal" | "external";
}

/** Strip a single leading `www.` for internal/external comparison. */
function normalizeHost(h: string): string {
  const lower = h.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  let base = baseUrl;
  for (const baseTag of findTags(html, "base")) {
    const attrs = parseAttrs(baseTag.attrsText);
    if (attrs.href) {
      try {
        base = new URL(attrs.href, baseUrl).toString();
      } catch {
        /* ignore */
      }
    }
    break;
  }

  let baseHost = "";
  try {
    baseHost = normalizeHost(new URL(base).host);
  } catch {
    /* no baseHost -- everything classified external */
  }

  // Lowercased view of the source, computed once. extractLinks is hot on large
  // pages with thousands of anchors; computing this inside the loop allocates
  // an N-byte string per anchor and turns link extraction into O(N*K) memory churn.
  const htmlLower = html.toLowerCase();

  const links: ExtractedLink[] = [];
  for (const tag of findTags(html, "a")) {
    const attrs = parseAttrs(tag.attrsText);
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

    // Extract inner text: find the end of this <a> by searching from contentStart
    // for the next </a>. Keep it simple -- nested <a> is invalid HTML.
    const closeIdx = htmlLower.indexOf("</a>", tag.contentStart);
    const innerHtml = closeIdx >= 0 ? html.slice(tag.contentStart, closeIdx) : "";
    const text = innerHtml
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    let host: string;
    try {
      host = normalizeHost(new URL(abs).host);
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
    "Extract every outbound link from an HTML page, resolved to absolute URLs. Each entry includes href, anchor text, optional rel/title, and an internal/external classification (bare-domain and www. treated as the same host). Anchors (#), javascript:, mailto:, tel:, data:, and file: URIs are skipped. Respects <base href>.",
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
