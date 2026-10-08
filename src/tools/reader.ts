import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import type { HttpRequester } from "../http.js";
import { htmlToMarkdown } from "../markdown.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";
import { stripHtmlToText, visibleTagMask } from "./content.js";
import {
  balancedTagAttrs,
  decodeHtmlEntities,
  findFirstTagText,
  findTags,
  firstBalancedTagContent,
  forEachBalancedTag,
  parseAttrs,
  type TagMask,
} from "./html.js";

const MIN_CANDIDATE_LENGTH = 200;

/** Class names common CMSes put on the article body. Tested on the parsed class value, never on raw tag text. */
const CMS_CLASS_RE =
  /\b(?:post-content|entry-content|article-content|article-body|story-body|article__body|markdown-body)\b/i;

/**
 * Pull out the main article body. Tries, in order:
 *   1. <article> whose text length passes the 200-char threshold
 *   2. <main>
 *   3. element with itemprop="articleBody"
 *   4. common CMS class names (post-content, entry-content, ...)
 *   5. <body> as ultimate fallback
 *
 * When multiple candidates exist at the same level, the longest one wins
 * so card lists don't hijack the real article.
 *
 * Only tags `visibleTagMask` marks count: an `<article>` or `</article>`
 * written in a script, a comment or a template would otherwise start or end
 * the slice in the middle of hidden text, and hand that text to the markdown
 * step as page content.
 */
export function isolateMainContent(html: string, mask: TagMask = visibleTagMask(html)): string {
  const article = longestOutermost(html, "article", mask);
  if (article !== null) return article;

  const main = longestOutermost(html, "main", mask);
  if (main !== null) return main;

  const { itemprop, cms } = findAttrContainers(html, mask);
  if (itemprop !== null && itemprop.length > MIN_CANDIDATE_LENGTH) return itemprop;
  if (cms !== null && cms.length > MIN_CANDIDATE_LENGTH) return cms;

  const body = firstBalancedTagContent(html, "body", mask);
  if (body) return body;
  return html;
}

/** `String.prototype.trim`'s whitespace: what `\s` matches. */
const TRIM_SPACE_RE = /\s/;
const isTrimSpace = (code: number, ch: string) =>
  code === 0x20 || (code >= 0x09 && code <= 0x0d) || (code > 0x7f && TRIM_SPACE_RE.test(ch));

/**
 * The trimmed content of the longest outermost `<tag>` pair past the
 * 200-char threshold (the first of equals), or null. Lengths are measured on
 * offsets and only the winner is sliced.
 */
function longestOutermost(html: string, tag: string, mask: TagMask): string | null {
  let bestFrom = 0;
  let bestTo = -1;
  forEachBalancedTag(html, tag, mask, (_start, contentStart, contentEnd, depth) => {
    if (depth !== 0) return undefined;
    let from = contentStart;
    let to = contentEnd;
    while (from < to && isTrimSpace(html.charCodeAt(from), html[from]!)) from++;
    while (to > from && isTrimSpace(html.charCodeAt(to - 1), html[to - 1]!)) to--;
    if (to - from > MIN_CANDIDATE_LENGTH && to - from > bestTo - bestFrom) {
      bestFrom = from;
      bestTo = to;
    }
    return undefined;
  });
  return bestTo === -1 ? null : html.slice(bestFrom, bestTo);
}

/**
 * The balanced content of the longest element whose opening tag carries
 * `itemprop="articleBody"`, and of the longest with a common CMS class (the
 * first of equals, in tag order). Looks at div, section, article, main -- the
 * tags that typically host article-body markers -- in one walk per tag, and
 * slices only the winners: slicing every candidate copies a nested chain of
 * matching containers quadratically.
 */
function findAttrContainers(html: string, mask: TagMask): { itemprop: string | null; cms: string | null } {
  let ipFrom = 0;
  let ipTo = -1;
  let cmsFrom = 0;
  let cmsTo = -1;
  for (const t of ["div", "section", "article", "main"]) {
    forEachBalancedTag(html, t, mask, (start, contentStart, contentEnd) => {
      if (contentEnd <= contentStart) return undefined;
      const attrs = parseAttrs(balancedTagAttrs(html, t, start, contentStart));
      const length = contentEnd - contentStart;
      if ((attrs.itemprop ?? "").toLowerCase() === "articlebody" && length > ipTo - ipFrom) {
        ipFrom = contentStart;
        ipTo = contentEnd;
      }
      if (CMS_CLASS_RE.test(attrs.class ?? "") && length > cmsTo - cmsFrom) {
        cmsFrom = contentStart;
        cmsTo = contentEnd;
      }
      return undefined;
    });
  }
  return {
    itemprop: ipTo === -1 ? null : html.slice(ipFrom, ipTo),
    cms: cmsTo === -1 ? null : html.slice(cmsFrom, cmsTo),
  };
}

/** The page title, from tags `visibleTagMask` marks only, as `isolateMainContent` reads them. */
export function extractTitle(html: string, mask: TagMask = visibleTagMask(html)): string | undefined {
  for (const tag of findTags(html, "meta", mask)) {
    const attrs = parseAttrs(tag.attrsText);
    const property = (attrs.property ?? attrs.name ?? "").toLowerCase();
    // parseAttrs has already decoded entities; decoding again turns `&amp;lt;` into `<`.
    if (property === "og:title" && attrs.content) return attrs.content.trim();
  }
  const t = findFirstTagText(html, "title", mask);
  if (t !== undefined) return decodeHtmlEntities(t.trim().replace(/\s+/g, " "));
  const h1 = firstBalancedTagContent(html, "h1", mask);
  if (h1 !== undefined) {
    const text = stripHtmlToText(h1);
    if (text) return text;
  }
  return undefined;
}

/** The author, from tags `visibleTagMask` marks only. */
export function extractByline(html: string, mask: TagMask = visibleTagMask(html)): string | undefined {
  for (const tag of findTags(html, "meta", mask)) {
    const attrs = parseAttrs(tag.attrsText);
    const name = (attrs.name ?? "").toLowerCase();
    if (name === "author" && attrs.content) return attrs.content.trim();
  }
  for (const tag of findTags(html, "meta", mask)) {
    const attrs = parseAttrs(tag.attrsText);
    const property = (attrs.property ?? "").toLowerCase();
    if (property === "article:author" && attrs.content) return attrs.content.trim();
  }
  return undefined;
}

export function registerReaderTools(server: McpServer, request: HttpRequester) {
  server.tool(
    "fetch_reader",
    "GET a URL, locate the main article body (prefers <article>, <main>, itemprop=articleBody, or known CMS class names; falls back to <body>), strip navigation/footer/aside chrome, and convert to clean markdown. Returns { title, byline, markdown, wordCount }. Optimized for feeding long-form articles into an LLM without header/footer/sidebar noise.",
    {
      url: z.string().url(),
      timeout_ms: z.number().int().positive().max(120_000).optional(),
      max_bytes: z.number().int().positive().optional(),
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
        maxBytes: max_bytes,
        maxRedirects: max_redirects,
        allowPrivateHosts: allow_private_hosts,
        userAgent: user_agent,
        decodeText: true,
      });
      if (res.error) return formatError(res.error);
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText}`);
      if (!res.bodyText) return formatError("empty body");

      // One scan of the page serves all three.
      const mask = visibleTagMask(res.bodyText);
      const title = extractTitle(res.bodyText, mask);
      const byline = extractByline(res.bodyText, mask);
      const mainHtml = isolateMainContent(res.bodyText, mask);
      const converted = await htmlToMarkdown(mainHtml, { signal: extra.signal, budgetMs: timeout_ms });
      if ("error" in converted) return formatError(converted.error);
      const markdown = converted.markdown.trim();
      const wordCount = markdown.split(/\s+/).filter(Boolean).length;

      return formatJson({ url: res.url, title, byline, wordCount, markdown });
    },
  );
}
