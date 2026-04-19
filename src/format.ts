import type { HttpResponse } from "./http.js";

function truncateForDisplay(s: string, max = 50_000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[... truncated ${s.length - max} chars ...]`;
}

export function formatHttpResponse(res: HttpResponse): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (res.error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Request failed: ${res.error}` }],
    };
  }

  const lines: string[] = [];
  lines.push(`HTTP/1.1 ${res.status} ${res.statusText}`.trimEnd());
  lines.push(`URL: ${res.url}`);
  if (res.redirects.length > 0) lines.push(`Redirects: ${res.redirects.length} hop(s)`);
  lines.push(`Duration: ${res.durationMs}ms`);
  lines.push("");
  lines.push("--- Headers ---");
  const keys = Object.keys(res.headers).sort();
  for (const k of keys) lines.push(`${k}: ${res.headers[k]}`);
  lines.push("");
  if (res.truncated) lines.push(`[body truncated at response-size cap]`);
  if (res.json !== undefined) {
    lines.push("--- Body (parsed JSON) ---");
    lines.push(truncateForDisplay(JSON.stringify(res.json, null, 2)));
  } else if (res.bodyText !== undefined) {
    lines.push("--- Body ---");
    lines.push(truncateForDisplay(res.bodyText));
  } else if (res.bodyBase64 !== undefined) {
    lines.push(`--- Body (base64, ${res.bodyBase64.length} chars) ---`);
    lines.push(truncateForDisplay(res.bodyBase64));
  }
  return {
    isError: !res.ok,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

export function formatJson(value: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: truncateForDisplay(text) }] };
}

export function formatError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}
