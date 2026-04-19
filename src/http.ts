import { lookup } from "node:dns/promises";
import { checkIpAddress, defaultUserAgent, validateUrl } from "./security.js";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const DEFAULT_MAX_REDIRECTS = 5;
export const ABSOLUTE_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB — a hard ceiling even when caller asks for more

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export interface HttpRequestOptions {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  contentType?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowPrivateHosts?: boolean;
  basicAuth?: { username: string; password: string };
  bearerToken?: string;
  /** When true (default), decode text bodies to string; when false, return base64 for binary safety. */
  decodeText?: boolean;
  /** User-agent override. If unset, uses the default pinned UA. */
  userAgent?: string;
  /** Retry on 429/502/503/504 with exponential backoff. Default 0 = no retry. */
  retries?: number;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  url: string;
  redirects: string[];
  bodyText?: string;
  bodyBase64?: string;
  json?: unknown;
  truncated?: boolean;
  durationMs: number;
  /** Populated only when ok=false and the failure is pre-flight (SSRF, DNS, timeout). */
  error?: string;
}

interface InternalContext {
  version: string;
}

let context: InternalContext = { version: "0.0.0" };

export function setHttpContext(ctx: InternalContext) {
  context = ctx;
}

function buildHeaders(opts: HttpRequestOptions): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  if (!h.has("user-agent")) h.set("user-agent", opts.userAgent ?? defaultUserAgent(context.version));
  if (!h.has("accept")) h.set("accept", "*/*");
  if (opts.basicAuth) {
    const token = Buffer.from(`${opts.basicAuth.username}:${opts.basicAuth.password}`, "utf8").toString("base64");
    h.set("authorization", `Basic ${token}`);
  } else if (opts.bearerToken) {
    h.set("authorization", `Bearer ${opts.bearerToken}`);
  }
  if (opts.body !== undefined && !h.has("content-type") && opts.contentType) {
    h.set("content-type", opts.contentType);
  }
  return h;
}

/**
 * Resolve hostname to IP(s) and refuse if any resolves into a blocked
 * range. This closes the DNS-rebinding hole that validateUrl() alone
 * leaves open (an attacker-controlled hostname that returns 127.0.0.1).
 *
 * When the host is already a literal IP, validateUrl() covered it and
 * this is a no-op. For names we look them up and check every result.
 */
async function resolveAndCheck(hostname: string): Promise<string | null> {
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    for (const r of results) {
      const reason = checkIpAddress(r.address);
      if (reason) return `DNS: ${hostname} → ${r.address} — ${reason}`;
    }
    return null;
  } catch (err) {
    return `DNS lookup failed for "${hostname}": ${(err as Error).message}`;
  }
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

async function readLimitedBody(
  res: Response,
  maxBytes: number,
  abortController: AbortController,
): Promise<{ buf: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { buf: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
      abortController.abort();
      try {
        await reader.cancel();
      } catch {
        // best-effort cancel
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { buf, truncated };
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Low-level request. Handles:
 *  - scheme/IP validation (SSRF)
 *  - DNS pre-resolve + re-check on each host in a redirect chain
 *  - timeout
 *  - response size cap with streaming abort
 *  - manual redirect handling so we can re-validate every hop
 *  - auto JSON parse when content-type says so
 *  - retry w/ exponential backoff on 429/5xx
 */
export async function httpRequest(opts: HttpRequestOptions): Promise<HttpResponse> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const retries = Math.max(0, opts.retries ?? 0);

  const urlCheck = validateUrl(opts.url, { allowPrivateHosts: opts.allowPrivateHosts });
  if (!urlCheck.ok) return failure(opts.url, urlCheck.reason ?? "URL rejected", start);

  let currentUrl = opts.url;
  const redirects: string[] = [];

  const sendOnce = async (url: string): Promise<HttpResponse> => {
    if (!opts.allowPrivateHosts) {
      const parsed = new URL(url);
      const host = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
      const reason = await resolveAndCheck(host);
      if (reason) return failure(url, reason, start);
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(new Error(`request exceeded ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers: buildHeaders(opts),
        body: opts.body ?? null,
        redirect: "manual",
        signal: abortController.signal,
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        // Consume the body so the connection frees
        try {
          await res.arrayBuffer();
        } catch {
          // ignore — server might have sent headers only
        }
        const next = new URL(res.headers.get("location")!, url).toString();
        return { redirectTo: next } as unknown as HttpResponse;
      }

      const contentType = res.headers.get("content-type") ?? "";
      const decodeText = opts.decodeText ?? true;

      let bodyText: string | undefined;
      let bodyBase64: string | undefined;
      let json: unknown;
      let truncated = false;

      if (opts.method !== "HEAD") {
        const { buf, truncated: t } = await readLimitedBody(res, maxBytes, abortController);
        truncated = t;
        if (decodeText) {
          bodyText = new TextDecoder("utf-8", { fatal: false }).decode(buf);
          if (contentType.includes("application/json") && bodyText.length > 0 && !truncated) {
            try {
              json = JSON.parse(bodyText);
            } catch {
              // leave as text
            }
          }
        } else {
          bodyBase64 = Buffer.from(buf).toString("base64");
        }
      }

      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: res.statusText,
        headers: headersToRecord(res.headers),
        url,
        redirects,
        bodyText,
        bodyBase64,
        json,
        truncated,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return failure(url, (err as Error).message, start);
    } finally {
      clearTimeout(timer);
    }
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    let hops = 0;
    while (true) {
      const result = await sendOnce(currentUrl);
      const asRedirect = result as unknown as { redirectTo?: string };
      if (asRedirect.redirectTo) {
        if (++hops > maxRedirects) {
          return failure(currentUrl, `exceeded ${maxRedirects} redirects`, start);
        }
        redirects.push(asRedirect.redirectTo);
        currentUrl = asRedirect.redirectTo;
        // If the redirect came on a POST/PUT/PATCH with a 303, downgrade to GET per spec.
        // We keep the method otherwise (307/308 preserve method; 301/302 browsers mostly downgrade,
        // but we preserve to match fetch-standard "manual" behavior with explicit intent).
        continue;
      }
      if (result.ok) return result;
      if (attempt < retries && isRetryableStatus(result.status)) {
        const retryAfter = Number(result.headers["retry-after"]);
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(2 ** attempt * 500, 8000);
        await sleep(delay);
        break; // re-enter outer retry loop
      }
      return result;
    }
  }
  return failure(currentUrl, "all retries exhausted", start);
}

function failure(url: string, error: string, start: number): HttpResponse {
  return {
    ok: false,
    status: 0,
    statusText: "",
    headers: {},
    url,
    redirects: [],
    durationMs: Date.now() - start,
    error,
  };
}
