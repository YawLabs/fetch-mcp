import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import type { HttpRequester } from "../http.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";
import { scriptEndTag, visibleTagMask } from "./content.js";
import { decodeHtmlEntities, findFirstTagText, findTags, parseAttrs, type TagMask } from "./html.js";

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
  /**
   * Present only when a collection hit its cap: the names of those
   * collections (`icons`, `feeds`, `og`, `twitter`, `article`, `jsonLd`).
   */
  truncated?: string[];
}

/** Most entries kept in `icons`, `feeds`, `jsonLd` and each `*All` array. */
export const MAX_META_LIST = 100;
/** Most distinct keys kept in each of `og`, `twitter` and `article`. */
export const MAX_META_KEYS = 1000;
/** A JSON-LD block nested deeper than this is dropped, unparsed. */
export const MAX_JSON_LD_DEPTH = 64;

/**
 * One `og:` / `twitter:` / `article:` family. A Map, not an object literal:
 * a key such as `constructor` or `__proto__` read the prototype's member as
 * an existing entry and threw on `.push`.
 */
class MetaFamily {
  readonly values = new Map<string, string[]>();
  truncated = false;

  add(key: string, value: string): void {
    let list = this.values.get(key);
    if (list === undefined) {
      if (this.values.size >= MAX_META_KEYS) {
        this.truncated = true;
        return;
      }
      list = [];
      this.values.set(key, list);
    }
    if (list.length >= MAX_META_LIST) {
      this.truncated = true;
      return;
    }
    list.push(value);
  }

  /** First observed value per key. `fromEntries` defines own properties, so `__proto__` stays a key. */
  first(): Record<string, string> {
    return Object.fromEntries([...this.values].map(([k, v]) => [k, v[0] as string]));
  }

  /** Only keys with more than one entry. */
  repeated(): Record<string, string[]> {
    return Object.fromEntries([...this.values].filter(([, v]) => v.length > 1));
  }
}

/**
 * Whether `raw` nests arrays/objects deeper than `limit`, in one linear pass
 * that skips string contents. Malformed input just answers by its brackets;
 * JSON.parse rejects it afterwards.
 */
export function jsonNestsDeeperThan(raw: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* backslash */) i++;
      else if (c === 0x22 /* " */) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b /* [ */ || c === 0x7b /* { */) {
      if (++depth > limit) return true;
    } else if (c === 0x5d /* ] */ || c === 0x7d /* } */) depth--;
  }
  return false;
}

/** Offset of the first `</head>` the mask marks, or -1. */
function headEndOffset(html: string, mask: TagMask): number {
  const re = /<\/head>/gi;
  for (;;) {
    const m = re.exec(html);
    if (m === null) return -1;
    if (mask[m.index] === 1) return m.index;
  }
}

/**
 * Only tags `visibleTagMask` marks count: a `<meta>`, `<link>` or `<title>`
 * written in a comment, a script, a style or a template is not metadata, and
 * reporting it handed hidden text to the caller as the page's own.
 */
export function parseHtmlMeta(html: string, baseUrl: string): PageMeta {
  const mask = visibleTagMask(html);
  // The head is a prefix of the page, so the mask's offsets hold for it too.
  const headEnd = headEndOffset(html, mask);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;

  const titleText = findFirstTagText(head, "title", mask);
  const title = titleText !== undefined ? decodeHtmlEntities(titleText.trim().replace(/\s+/g, " ")) : undefined;

  const htmlTag = findTags(html, "html", mask).next();
  const language = htmlTag.done ? undefined : parseAttrs(htmlTag.value.attrsText).lang;

  const og = new MetaFamily();
  const twitter = new MetaFamily();
  const article = new MetaFamily();
  const truncated = new Set<string>();
  let description: string | undefined;
  let robots: string | undefined;

  for (const tag of findTags(head, "meta", mask)) {
    const attrs = parseAttrs(tag.attrsText);
    const rawName = attrs.property ?? attrs.name ?? attrs.itemprop ?? "";
    const name = rawName.toLowerCase();
    const content = attrs.content;
    if (!name || content === undefined) continue;
    if (name === "description") description = description ?? content;
    else if (name === "robots") robots = robots ?? content;
    else if (name.startsWith("og:")) og.add(name.slice(3), content);
    else if (name.startsWith("twitter:")) twitter.add(name.slice(8), content);
    else if (name.startsWith("article:")) article.add(name.slice(8), content);
  }

  let canonical: string | undefined;
  const icons: PageMeta["icons"] = [];
  const feeds: PageMeta["feeds"] = [];
  for (const tag of findTags(head, "link", mask)) {
    const attrs = parseAttrs(tag.attrsText);
    const rel = (attrs.rel ?? "").toLowerCase();
    const href = attrs.href;
    if (!href || !rel) continue;
    // Resolve only what is kept: each resolved href carries the whole base
    // URL, so resolving every link cost time and memory in links x URL length.
    if (rel === "canonical" && canonical === undefined) canonical = resolveUrl(baseUrl, href);
    if (rel.includes("icon")) {
      if (icons.length >= MAX_META_LIST) truncated.add("icons");
      else {
        const icon: PageMeta["icons"][number] = { rel, href: resolveUrl(baseUrl, href) };
        if (attrs.sizes) icon.sizes = attrs.sizes;
        icons.push(icon);
      }
    }
    if (rel === "alternate") {
      const type = attrs.type ?? "";
      if (type.includes("rss") || type.includes("atom") || type.includes("xml") || type.includes("json")) {
        if (feeds.length >= MAX_META_LIST) {
          truncated.add("feeds");
          continue;
        }
        const feed: PageMeta["feeds"][number] = { href: resolveUrl(baseUrl, href) };
        if (attrs.title) feed.title = attrs.title;
        if (type) feed.type = type;
        feeds.push(feed);
      }
    }
  }

  const jsonLd: unknown[] = [];
  // Each block ends where a browser ends the script: at the `</script` the
  // scan itself stops at (escape states and `</script x>` / `</script/>`
  // included), not at the next `</script>` spelled one way, which read the
  // markup after a `</script x>` -- comments, styles -- into the JSON. The
  // mask marks only scripts outside one another, so the blocks do not
  // overlap and the searches stay linear.
  for (const tag of findTags(html, "script", mask)) {
    if ((parseAttrs(tag.attrsText).type ?? "").trim().toLowerCase() !== "application/ld+json") continue;
    const close = scriptEndTag(html, tag.contentStart);
    if (close === -1) break;
    const raw = html.slice(tag.contentStart, close).trim();
    if (!raw) continue;
    // Too many blocks, or one nested past the limit, is dropped before
    // JSON.parse: the depth would only amplify the pretty-printed output.
    if (jsonLd.length >= MAX_META_LIST || jsonNestsDeeperThan(raw, MAX_JSON_LD_DEPTH)) {
      truncated.add("jsonLd");
      continue;
    }
    try {
      jsonLd.push(JSON.parse(raw));
    } catch {
      // malformed JSON-LD -- skip rather than fail the whole request
    }
  }

  for (const [name, family] of [
    ["og", og],
    ["twitter", twitter],
    ["article", article],
  ] as const) {
    if (family.truncated) truncated.add(name);
  }

  const meta: PageMeta = {
    url: baseUrl,
    title,
    description,
    canonical,
    language,
    robots,
    og: og.first(),
    twitter: twitter.first(),
    article: article.first(),
    ogAll: og.repeated(),
    twitterAll: twitter.repeated(),
    articleAll: article.repeated(),
    icons,
    feeds,
    jsonLd,
  };
  if (truncated.size > 0) meta.truncated = [...truncated];
  return meta;
}

function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export function registerMetaTools(server: McpServer, request: HttpRequester) {
  server.tool(
    "fetch_meta",
    "GET a URL and extract its head metadata: title, description, canonical, language, robots directive, Open Graph / Twitter Card / article: properties, icon links, RSS/Atom feed links, and any JSON-LD (schema.org) blocks. Keys that appear more than once (e.g. multiple og:image tags) are additionally returned via ogAll/twitterAll/articleAll arrays. Lists are capped: at most 100 icons, feeds, JSON-LD blocks and values per *All key, and 1000 keys per og/twitter/article; a JSON-LD block nested deeper than 64 levels is dropped. When anything is cut, `truncated` names the collections affected. Ideal for previewing a page before fully reading it.",
    {
      url: z.string().url().describe("URL to extract metadata from"),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      max_bytes: z.number().int().positive().optional().describe("Default 2MiB — metadata lives in <head>"),
      max_redirects: z.number().int().min(0).max(20).optional(),
      allow_private_hosts: z.boolean().optional().describe(ALLOW_PRIVATE_HOSTS_DESCRIPTION),
      user_agent: z.string().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, timeout_ms, max_bytes, max_redirects, allow_private_hosts, user_agent }, extra) => {
      const res = await request({
        signal: extra.signal,
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
