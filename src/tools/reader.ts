import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";
import { makeTurndown, stripHtmlToText } from "./content.js";
import { decodeHtmlEntities, findBalancedTagContents, findTags, parseAttrs } from "./html.js";

const MIN_CANDIDATE_LENGTH = 200;

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
 */
export function isolateMainContent(html: string): string {
  const pickLongestAbove = (tag: string): string | null => {
    const candidates = findBalancedTagContents(html, tag)
      .map((c) => c.trim())
      .filter((c) => c.length > MIN_CANDIDATE_LENGTH);
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (b.length > a.length ? b : a));
  };

  const article = pickLongestAbove("article");
  if (article) return article;

  const main = pickLongestAbove("main");
  if (main) return main;

  const itemprop = findAttrContainerContent(html, /\bitemprop\s*=\s*["']articleBody["']/i);
  if (itemprop && itemprop.length > MIN_CANDIDATE_LENGTH) return itemprop;

  const cms = findAttrContainerContent(
    html,
    /\bclass\s*=\s*["'][^"']*\b(?:post-content|entry-content|article-content|article-body|story-body|article__body|markdown-body)\b[^"']*["']/i,
  );
  if (cms && cms.length > MIN_CANDIDATE_LENGTH) return cms;

  const body = findBalancedTagContents(html, "body")[0];
  if (body) return body;
  return html;
}

/**
 * Find the balanced content of the first element whose opening tag's attribute
 * section satisfies `attrPredicate`. Looks at div, section, article, main --
 * the tags that typically host article-body markers.
 */
function findAttrContainerContent(html: string, attrPredicate: RegExp): string | null {
  const tags = ["div", "section", "article", "main"];
  let best: { content: string; start: number } | null = null;
  for (const t of tags) {
    for (const opener of findTags(html, t)) {
      if (!attrPredicate.test(opener.attrsText)) continue;
      const all = findBalancedTagContents(html.slice(opener.start), t);
      const content = all[0];
      if (!content) continue;
      if (!best || content.length > best.content.length) best = { content, start: opener.start };
    }
  }
  return best?.content ?? null;
}

export function extractTitle(html: string): string | undefined {
  for (const tag of findTags(html, "meta")) {
    const attrs = parseAttrs(tag.attrsText);
    const property = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (property === "og:title" && attrs.content) return decodeHtmlEntities(attrs.content.trim());
  }
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) return decodeHtmlEntities(t[1]!.trim().replace(/\s+/g, " "));
  const h1Contents = findBalancedTagContents(html, "h1");
  if (h1Contents.length > 0) {
    const text = stripHtmlToText(h1Contents[0]!);
    if (text) return text;
  }
  return undefined;
}

export function extractByline(html: string): string | undefined {
  for (const tag of findTags(html, "meta")) {
    const attrs = parseAttrs(tag.attrsText);
    const name = (attrs.name ?? "").toLowerCase();
    if (name === "author" && attrs.content) return decodeHtmlEntities(attrs.content.trim());
  }
  for (const tag of findTags(html, "meta")) {
    const attrs = parseAttrs(tag.attrsText);
    const property = (attrs.property ?? "").toLowerCase();
    if (property === "article:author" && attrs.content) return decodeHtmlEntities(attrs.content.trim());
  }
  return undefined;
}

export function registerReaderTools(server: McpServer) {
  server.tool(
    "fetch_reader",
    "GET a URL, locate the main article body (prefers <article>, <main>, itemprop=articleBody, or known CMS class names; falls back to <body>), strip navigation/footer/aside chrome, and convert to clean markdown. Returns { title, byline, markdown, wordCount }. Optimized for feeding long-form articles into an LLM without header/footer/sidebar noise.",
    {
      url: z.string().url(),
      timeout_ms: z.number().int().positive().max(120_000).optional(),
      max_bytes: z.number().int().positive().optional(),
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
        maxBytes: max_bytes,
        maxRedirects: max_redirects,
        allowPrivateHosts: allow_private_hosts,
        userAgent: user_agent,
        decodeText: true,
      });
      if (res.error) return formatError(res.error);
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText}`);
      if (!res.bodyText) return formatError("empty body");

      const title = extractTitle(res.bodyText);
      const byline = extractByline(res.bodyText);
      const mainHtml = isolateMainContent(res.bodyText);
      const markdown = makeTurndown().turndown(mainHtml).trim();
      const wordCount = markdown.split(/\s+/).filter(Boolean).length;

      return formatJson({ url: res.url, title, byline, wordCount, markdown });
    },
  );
}
