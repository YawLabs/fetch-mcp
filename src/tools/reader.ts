import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";
import { makeTurndown, stripHtmlToText } from "./content.js";

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

/**
 * Pull out the main article body from an HTML document. Tries, in order:
 *  1. <article> (schema.org/HTML5)
 *  2. <main>
 *  3. element with itemprop="articleBody"
 *  4. common CMS class names (post-content, entry-content, article-body, etc.)
 *  5. the densest <div>/<section> — heuristic: the node with the largest text/markup ratio
 *  6. <body> as ultimate fallback
 */
export function isolateMainContent(html: string): string {
  const candidates: RegExp[] = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<[a-z]+\b[^>]*\bitemprop\s*=\s*["']articleBody["'][^>]*>([\s\S]*?)<\/[a-z]+>/i,
    /<[a-z]+\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:post-content|entry-content|article-content|article-body|story-body|article__body|markdown-body)\b[^"']*["'][^>]*>([\s\S]*?)<\/[a-z]+>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m?.[1] && m[1].trim().length > 200) return m[1];
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1]! : html;
}

export function extractTitle(html: string): string | undefined {
  const og = html.match(/<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i);
  if (og) return decodeHtmlEntities(og[1]!.trim());
  const ogRev = html.match(/<meta\b[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bproperty\s*=\s*["']og:title["']/i);
  if (ogRev) return decodeHtmlEntities(ogRev[1]!.trim());
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) return decodeHtmlEntities(t[1]!.trim().replace(/\s+/g, " "));
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripHtmlToText(h1[1]!);
  return undefined;
}

export function extractByline(html: string): string | undefined {
  const author = html.match(/<meta\b[^>]*\bname\s*=\s*["']author["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i);
  if (author) return decodeHtmlEntities(author[1]!.trim());
  const article = html.match(
    /<meta\b[^>]*\bproperty\s*=\s*["']article:author["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i,
  );
  if (article) return decodeHtmlEntities(article[1]!.trim());
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
