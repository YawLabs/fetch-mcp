import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import type { HttpRequester } from "../http.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";
import { stripHtmlToText } from "./content.js";
import { type FoundTag, findTagEnd, parseAttrs } from "./html.js";

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

/** What `scanVisible` reports, in document order. */
interface VisibleMarkup {
  /** An `<a>` start tag. Return true to stop the scan. */
  anchor(tag: FoundTag): boolean;
  /** The `<` of an `</a>` end tag. */
  close(lt: number): void;
  /** The first `<base>` tag. */
  base(tag: FoundTag): void;
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
 * hides the rest of the page. The same pass finds the first `<base>` and every
 * `</a>`, so a `<base href>` or `</a>` written in hidden markup does not
 * re-root every link or cut an anchor's text short.
 *
 * Reported as found, not collected: a page of 20 million `<a>` tags built
 * every one of them before fetch_links kept its first thousand.
 */
function scanVisible(html: string, visit: VisibleMarkup): void {
  const n = html.length;
  let sawBase = false;
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
      else if (name === "a" && template === 0) visit.close(lt);
      continue;
    }
    if ((name === "a" || (name === "base" && !sawBase)) && template === 0) {
      const rawAttrs = html.slice(lt + 1 + name.length, end.pos);
      const tag: FoundTag = {
        start: lt,
        contentStart: after,
        // Drop only a self-closing `/`: in `<a href=/blog/>` the slash belongs to the value.
        attrsText: end.selfClosing ? rawAttrs.slice(0, -1) : rawAttrs,
        selfClosing: end.selfClosing,
      };
      if (name === "a") {
        if (visit.anchor(tag)) return;
      } else {
        sawBase = true;
        visit.base(tag);
      }
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
}

export interface LinkOptions {
  /** Keep only internal or only external links (default all). */
  filter?: "all" | "internal" | "external";
  /** Skip a link whose href was already kept (default false; fetch_links turns it on). */
  dedupe?: boolean;
  /** Keep at most this many links (default no cap). */
  limit?: number;
}

export interface LinkResult {
  links: ExtractedLink[];
  /** Whether the page has a link past `limit` that would also have been kept. */
  truncated: boolean;
}

interface ResolvedHref {
  abs: string;
  type: ExtractedLink["type"];
}

/** Trimmed hrefs whose resolution `collectLinks` remembers at a time. */
const RESOLVED_CACHE_SIZE = 1024;

export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  return collectLinks(html, baseUrl).links;
}

/**
 * The links of a page, filtered, deduplicated and capped as they are found.
 * The walk stops at the first link past `limit`, and only kept links get
 * their text extracted, so memory and time past the scan scale with the cap,
 * not with the number of anchors on the page.
 */
export function collectLinks(html: string, baseUrl: string, opts: LinkOptions = {}): LinkResult {
  // A first pass, keeping nothing, finds the `<base>` (it applies to the
  // anchors before it too) and the last `</a>`: an anchor with none after it
  // has no text.
  let baseTag: FoundTag | undefined;
  let lastClose = -1;
  scanVisible(html, {
    anchor: () => false,
    close: (lt) => {
      lastClose = lt;
    },
    base: (tag) => {
      baseTag = tag;
    },
  });

  let base = baseUrl;
  const baseHref = baseTag ? parseAttrs(baseTag.attrsText).href : undefined;
  if (baseHref) {
    try {
      base = new URL(baseHref, baseUrl).toString();
    } catch {
      /* ignore */
    }
  }

  let baseHost = "";
  try {
    baseHost = normalizeHost(new URL(base).host);
  } catch {
    /* no baseHost -- everything classified external */
  }

  // Keep http(s) only, judged on the parsed URL. A prefix deny-list on the
  // raw href missed vbscript: and every scheme nobody listed, and the URL
  // parser drops tabs and newlines and leading control characters, so
  // "java\tscript:" and "\x01javascript:" both parse as javascript:.
  const resolve = (href: string): ResolvedHref | null => {
    let parsed: URL;
    try {
      parsed = new URL(href, base);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { abs: parsed.toString(), type: normalizeHost(parsed.host) === baseHost ? "internal" : "external" };
  };
  const resolved = new Map<string, ResolvedHref | null>();

  const filter = opts.filter ?? "all";
  const seen = opts.dedupe ? new Set<string>() : undefined;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const links: ExtractedLink[] = [];
  let truncated = false;
  // The last kept link, until the next `<a>` or the end of the page ends its
  // text, and the first `</a>` after its start tag (-1 until one is seen).
  let open: { link: ExtractedLink; contentStart: number; close: number } | undefined;

  // A new <a> also ends the one before it, as in a browser, so the text of
  // anchors that share one far-off </a> is not copied once per anchor. With
  // no </a> anywhere after it, an anchor has no text: running it to the end
  // of the page would hand back the rest of the document, scripts and all, as
  // one link's text.
  const endText = (nextStart: number) => {
    if (open === undefined) return;
    const { link, contentStart, close } = open;
    open = undefined;
    let innerEnd = contentStart;
    if (close !== -1) innerEnd = Math.min(close, nextStart);
    else if (lastClose >= contentStart) innerEnd = nextStart;
    // stripHtmlToText drops script, style, template and comment content and
    // decodes entities once, after every tag is gone.
    link.text = stripHtmlToText(html.slice(contentStart, innerEnd)).replace(/\s+/g, " ").trim();
  };

  scanVisible(html, {
    anchor: (tag) => {
      endText(tag.start);
      const attrs = parseAttrs(tag.attrsText);
      const href = attrs.href;
      if (!href) return false;
      const trimmed = href.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;

      let target = resolved.get(trimmed);
      if (target === undefined) {
        target = resolve(trimmed);
        // Pages repeat a few hrefs many times; a page of all-distinct ones
        // just keeps restarting the cache.
        if (resolved.size >= RESOLVED_CACHE_SIZE) resolved.clear();
        resolved.set(trimmed, target);
      }
      if (target === null) return false;
      const { abs, type } = target;
      if (filter !== "all" && type !== filter) return false;
      if (seen?.has(abs)) return false;
      if (links.length >= limit) {
        truncated = true;
        return true;
      }
      seen?.add(abs);

      const link: ExtractedLink = { href: abs, text: "", type };
      if (attrs.rel) link.rel = attrs.rel;
      if (attrs.title) link.title = attrs.title;
      links.push(link);
      open = { link, contentStart: tag.contentStart, close: -1 };
      return false;
    },
    close: (lt) => {
      if (open !== undefined && open.close === -1) open.close = lt;
    },
    base: () => {},
  });
  endText(html.length);
  return { links, truncated };
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
      const { links, truncated } = collectLinks(res.bodyText, res.url, {
        filter,
        dedupe: dedupe !== false,
        limit: limit ?? 1000,
      });
      return formatJson({ url: res.url, linkCount: links.length, truncated, links });
    },
  );
}
