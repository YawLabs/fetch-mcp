import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import type { HttpRequester } from "../http.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";
import { stripHtmlToText } from "./content.js";
import { type FoundTag, findTagEnd, findTags, parseAttrs } from "./html.js";

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

/** A tag name runs, as in a browser, to whitespace, `/` or `>`. */
const TAG_NAME_RE = /[a-zA-Z][^\t\n\f\r />]*/y;

/** Comment ends: `-->`, or `--!>`, which a browser also accepts. */
const COMMENT_END_RE = /--!?>/g;

/**
 * Elements whose content is raw text or RCDATA: a `<a>` written inside one is
 * text, not an anchor. `<script>` is handled on its own (escape states).
 */
const RAW_TEXT_ELEMENTS = ["style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"];
const RAW_END_RE = new Map(
  RAW_TEXT_ELEMENTS.map((name) => [name, new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, "gi")]),
);

const isNameEnd = (ch: string | undefined) =>
  ch === undefined ||
  ch === "/" ||
  ch === ">" ||
  ch === " " ||
  ch === "\t" ||
  ch === "\n" ||
  ch === "\f" ||
  ch === "\r";

/** Index just past the `<!--` comment whose body starts at `from`; the end of the input when unterminated. */
function commentEnd(html: string, from: number): number {
  // `<!-->` and `<!--->` are complete (empty) comments.
  if (html[from] === ">") return from + 1;
  if (html.startsWith("->", from)) return from + 2;
  COMMENT_END_RE.lastIndex = from;
  const m = COMMENT_END_RE.exec(html);
  return m === null ? html.length : m.index + m[0].length;
}

/** Index just past the end tag of `name` whose `<` is at `close`. */
function endTagEnd(html: string, close: number, name: string): number {
  const end = findTagEnd(html, close + 2 + name.length);
  return end === null ? html.length : end.pos + 1;
}

/**
 * Index of the `</script` that ends a script whose content starts at `from`,
 * or -1. Inside `<!-- ... -->` in a script, a `<script` opens a nested
 * ("double-escaped") region whose own `</script>` does not end the element.
 */
function scriptEndTag(html: string, from: number): number {
  let state: "data" | "escaped" | "double" = "data";
  let i = from;
  for (;;) {
    const nextLt = html.indexOf("<", i);
    // Only `-->` leaves an escaped region, and it holds no `<`: the one that
    // matters lies before the next `<`, so only that stretch is searched.
    if (state !== "data") {
      const stop = nextLt === -1 ? html.length : nextLt;
      let k = i;
      while (k + 3 <= stop && !html.startsWith("-->", k)) k++;
      if (k + 3 <= stop) {
        state = "data";
        i = k + 3;
        continue;
      }
    }
    if (nextLt === -1) return -1;
    const lt = nextLt;
    i = lt + 1;
    if (html.startsWith("<!--", lt)) {
      if (state === "data") state = "escaped";
      // Resume inside the `<!--` so the `-->` of `<!-->` and `<!--->` closes it at once.
      i = lt + 2;
      continue;
    }
    const closing = html[lt + 1] === "/";
    const at = lt + (closing ? 2 : 1);
    if (html.slice(at, at + 6).toLowerCase() !== "script" || !isNameEnd(html[at + 6])) continue;
    if (closing) {
      if (state !== "double") return lt;
      state = "escaped";
    } else if (state === "escaped") {
      state = "double";
    }
  }
}

/**
 * Every `<a>` start tag a browser would read as one, in document order, in one
 * left-to-right pass. `findTags(html, "a")` matched `<a` anywhere, so anchors
 * written inside a comment, a `<script>` or `<style>` (or any raw-text
 * element), a `<template>`, or another tag's attribute value came back as
 * links. Here a comment or bogus comment runs to its end, a raw-text element
 * to its end tag (in any case, with whitespace or attributes before the `>`),
 * and either runs to the end of the input when it never ends; markup inside a
 * `<template>` is skipped to its matching `</template>`, and `<plaintext>`
 * hides the rest of the page.
 */
function visibleAnchors(html: string): FoundTag[] {
  const n = html.length;
  const anchors: FoundTag[] = [];
  let template = 0;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      i = commentEnd(html, lt + 4);
      continue;
    }
    const next = html[lt + 1];
    if (next === "!" || next === "?") {
      // <!DOCTYPE>, <?xml ?> and other bogus comments run to the next `>`.
      const gt = html.indexOf(">", lt + 2);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    const closing = next === "/";
    TAG_NAME_RE.lastIndex = lt + (closing ? 2 : 1);
    const m = TAG_NAME_RE.exec(html);
    if (m === null) {
      if (closing) {
        // `</>` is dropped; `</ ...>` and friends are bogus comments.
        const gt = html.indexOf(">", lt + 2);
        i = gt === -1 ? n : gt + 1;
      } else {
        i = lt + 1; // a `<` that starts no tag is text
      }
      continue;
    }
    const name = m[0].toLowerCase();
    const end = findTagEnd(html, TAG_NAME_RE.lastIndex);
    // A tag cut off by the end of the input swallows everything after it.
    if (end === null) break;
    const after = end.pos + 1;
    i = after;
    if (closing) {
      if (name === "template" && template > 0) template--;
      continue;
    }
    if (name === "a" && template === 0) {
      const rawAttrs = html.slice(lt + 2, end.pos);
      anchors.push({
        start: lt,
        contentStart: after,
        // Drop only a self-closing `/`: in `<a href=/blog/>` the slash belongs to the value.
        attrsText: end.selfClosing ? rawAttrs.slice(0, -1) : rawAttrs,
        selfClosing: end.selfClosing,
      });
    } else if (name === "template") {
      template++;
    } else if (name === "plaintext") {
      break;
    } else if (name === "script") {
      // A browser ignores the self-closing slash here: `<script src=x />` still runs to `</script>`.
      const close = scriptEndTag(html, after);
      i = close === -1 ? n : endTagEnd(html, close, name);
    } else {
      const re = RAW_END_RE.get(name);
      if (re !== undefined) {
        re.lastIndex = after;
        const close = re.exec(html);
        i = close === null ? n : endTagEnd(html, close.index, name);
      }
    }
  }
  return anchors;
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
  const anchors = visibleAnchors(html);
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
    // stripHtmlToText drops script, style, template and comment content and
    // decodes entities once, after every tag is gone.
    const text = stripHtmlToText(html.slice(tag.contentStart, innerEnd)).replace(/\s+/g, " ").trim();

    const host = normalizeHost(parsed.host);

    const link: ExtractedLink = {
      href: abs,
      text,
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
