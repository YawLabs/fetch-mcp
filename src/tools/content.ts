import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import TurndownService from "turndown";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";

export function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
  });
  td.addRule("removeScriptStyle", {
    filter: ["script", "style", "noscript", "iframe", "svg", "canvas"],
    replacement: () => "",
  });
  td.addRule("removeNav", {
    filter: (node) => {
      const el = node as unknown as { tagName?: string };
      return el.tagName === "NAV" || el.tagName === "FOOTER" || el.tagName === "ASIDE";
    },
    replacement: () => "",
  });
  return td;
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function registerContentTools(server: McpServer) {
  server.tool(
    "fetch_html_to_markdown",
    "GET a URL, decode the HTML, and convert to clean markdown (headings, lists, links, code fences). Scripts, styles, iframes, nav, footer, and aside elements are stripped. Intended for feeding web pages into an LLM cheaply — markdown is usually 3–8× smaller than raw HTML. Follows redirects, respects size/timeout limits, and blocks private-host requests by default.",
    {
      url: z.string().url().describe("URL to fetch"),
      timeout_ms: z.number().int().positive().max(120_000).optional().describe("Request timeout in ms (default 10000)"),
      max_bytes: z.number().int().positive().optional().describe("Max response size in bytes (default 5MiB)"),
      max_redirects: z.number().int().min(0).max(20).optional().describe("Max redirect hops (default 5)"),
      allow_private_hosts: z
        .boolean()
        .optional()
        .describe("Allow loopback / private / link-local addresses (default false)"),
      user_agent: z.string().optional().describe("User-Agent override"),
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
      if (!res.bodyText) return formatError("response body was empty");
      try {
        const markdown = makeTurndown().turndown(res.bodyText);
        return formatJson(markdown.trim());
      } catch (err) {
        return formatError(`HTML-to-markdown conversion failed: ${(err as Error).message}`);
      }
    },
  );

  server.tool(
    "fetch_html_to_text",
    "GET a URL, decode the HTML, and return plain text with block-level structure preserved as newlines. Scripts, styles, and comments stripped; HTML entities decoded. Lighter than markdown when you only need the reading content.",
    {
      url: z.string().url().describe("URL to fetch"),
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
      if (!res.bodyText) return formatError("response body was empty");
      return formatJson(stripHtmlToText(res.bodyText));
    },
  );
}
