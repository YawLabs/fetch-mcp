import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import type { HttpRequester } from "../http.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";
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

/**
 * Replace each `<...>` with a space (`<>` stays as text), by hand: `/<[^>]+>/g` searched to the
 * end of the text from every `<` with no `>` after it, quadratic in the number
 * of them. A `<` with no `>` after it, and everything after it, stay as text.
 */
function stripTags(s: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt === -1) return out + s.slice(i);
    const gt = s.indexOf(">", lt + 1);
    if (gt === -1) return out + s.slice(i);
    out += `${s.slice(i, lt)}${gt > lt + 1 ? " " : "<>"}`;
    i = gt + 1;
  }
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

  // Finds the `</a>` that ends each anchor, searched case-insensitively in
  // place. A lowercased copy of the page can differ in length ("\u0130"
  // lowercases to two code units), which shifted every later index.
  const closeA = /<\/a\s*>/gi;
  /** The next `</a>` found so far: undefined before a search, null once there is none. */
  let close: RegExpExecArray | null | undefined;

  const links: ExtractedLink[] = [];
  const anchors = [...findTags(html, "a")];
  for (let k = 0; k < anchors.length; k++) {
    const tag = anchors[k]!;
    const attrs = parseAttrs(tag.attrsText);
    const href = attrs.href;
    if (!href) continue;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Keep http(s) only, judged on the parsed URL. A prefix deny-list on the
    // raw href missed vbscript: and every scheme nobody listed, and the URL
    // parser drops tabs and newlines and leading control characters, so
    // "java\tscript:" and "\x01javascript:" both parse as javascript:.
    let parsed: URL;
    try {
      parsed = new URL(trimmed, base);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const abs = parsed.toString();

    // Anchors come in document order, so a close found for an earlier anchor
    // that lies past this one is this one's too, and once none is left none
    // ever will be. Searching afresh from every anchor read to the end of the
    // input once per unclosed anchor: quadratic.
    if (close !== null && close !== undefined && close.index < tag.contentStart) close = undefined;
    if (close === undefined) {
      closeA.lastIndex = tag.contentStart;
      close = closeA.exec(html);
    }
    // A new <a> also ends the one before it, as in a browser, so the text of
    // anchors that share one far-off </a> is not copied once per anchor.
    // With no </a> anywhere after it, an anchor has no text: running it to
    // the end of the page would hand back the rest of the document, scripts
    // and all, as one link's text.
    const nextStart = anchors[k + 1]?.start ?? html.length;
    const innerEnd = close ? Math.min(close.index, nextStart) : tag.contentStart;
    const text = stripTags(html.slice(tag.contentStart, innerEnd)).replace(/\s+/g, " ").trim();

    const host = normalizeHost(parsed.host);

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

export function registerLinksTools(server: McpServer, request: HttpRequester) {
  server.tool(
    "fetch_links",
    "Extract every outbound link from an HTML page, resolved to absolute URLs. Each entry includes href, anchor text, optional rel/title, and an internal/external classification (bare-domain and www. treated as the same host). Only http and https links are returned: anchors (#) and every other scheme (javascript:, mailto:, tel:, data:, file:, ...) are skipped. Respects <base href>.",
    {
      url: z.string().url(),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      max_bytes: z.number().int().positive().optional(),
      max_redirects: z.number().int().min(0).max(20).optional(),
      allow_private_hosts: z.boolean().optional().describe(ALLOW_PRIVATE_HOSTS_DESCRIPTION),
      user_agent: z.string().optional(),
      dedupe: z.boolean().optional().describe("Drop duplicate hrefs (default true)"),
      filter: z.enum(["all", "internal", "external"]).optional().describe("Filter by type (default 'all')"),
      limit: z.number().int().min(1).max(10_000).optional().describe("Cap on returned links (default 1000)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (
      { url, timeout_ms, max_bytes, max_redirects, allow_private_hosts, user_agent, dedupe, filter, limit },
      extra,
    ) => {
      const res = await request({
        signal: extra.signal,
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
