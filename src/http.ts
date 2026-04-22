import { lookup } from "node:dns/promises";
import { Agent } from "undici";
import { checkIpAddress, defaultUserAgent, validateUrl } from "./security.js";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const DEFAULT_MAX_REDIRECTS = 5;
export const ABSOLUTE_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB — hard ceiling

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
  /**
   * true  — always decode body as text (respecting Content-Type charset).
   * false — return base64 regardless of content-type.
   * undefined — auto: text for text/*, JSON, XML, form-urlencoded; binary otherwise.
   */
  decodeText?: boolean;
  userAgent?: string;
  /** Retry on 408/425/429/5xx with exponential backoff (honors Retry-After). Default 0. */
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
  error?: string;
}

interface InternalContext {
  version: string;
}

let context: InternalContext = { version: "0.0.0" };

export function setHttpContext(ctx: InternalContext) {
  context = ctx;
}

/**
 * Decide whether to decode a response as text based on Content-Type.
 * Returns true for text, JSON, XML, JS, CSS, and form-urlencoded responses.
 */
export function shouldDecodeAsText(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  if (!ct) return true; // No CT — assume text; caller may override with decodeText=false
  if (ct.startsWith("text/")) return true;
  if (ct === "application/json" || ct.endsWith("+json")) return true;
  if (ct === "application/xml" || ct === "application/xhtml+xml" || ct.endsWith("+xml")) return true;
  if (ct === "application/javascript" || ct === "application/ecmascript") return true;
  if (ct === "application/x-www-form-urlencoded") return true;
  return false;
}

/**
 * Pull the charset declaration out of a Content-Type header.
 * Returns "utf-8" when absent or unrecognized.
 */
export function extractCharset(contentType: string): string {
  const m = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  if (!m) return "utf-8";
  const raw = m[1]!.toLowerCase();
  // Common alias fixups for TextDecoder
  if (raw === "utf8") return "utf-8";
  if (raw === "iso8859-1") return "iso-8859-1";
  return raw;
}

/**
 * Decode bytes as text using the charset from Content-Type, falling back
 * to utf-8 when the label is not supported by the platform.
 */
export function decodeBytes(buf: Uint8Array, contentType: string): string {
  const charset = extractCharset(contentType);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

/**
 * Parse a Retry-After header value. Accepts:
 *   - delta-seconds: "30"
 *   - HTTP-date:    "Wed, 21 Oct 2025 07:28:00 GMT"
 * Returns ms, or undefined when unparseable.
 */
export function parseRetryAfter(raw: string | undefined, now = Date.now()): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.min(asNum * 1000, 60_000);
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, Math.min(asDate - now, 60_000));
  return undefined;
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/**
 * Resolve hostname to IP(s), refuse any that land in a blocked range, and
 * return the first safe address so we can dial it directly. Dialing the
 * pre-resolved IP closes the DNS-rebinding TOCTOU window that exists when
 * we re-lookup inside `fetch`.
 */
async function resolveAndPin(
  hostname: string,
): Promise<{ ok: true; ip: string; family: 4 | 6 } | { ok: false; reason: string }> {
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    if (results.length === 0) return { ok: false, reason: `DNS: ${hostname} returned no addresses` };
    for (const r of results) {
      const reason = checkIpAddress(r.address);
      if (reason) return { ok: false, reason: `DNS: ${hostname} -> ${r.address} -- ${reason}` };
    }
    const first = results[0]!;
    return { ok: true, ip: first.address, family: first.family === 6 ? 6 : 4 };
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed for "${hostname}": ${(err as Error).message}` };
  }
}

/**
 * Build an undici Agent whose `lookup` hook hard-pins to a specific IP.
 * This ensures the kernel dials the IP we verified, not one a racing
 * DNS server returns a millisecond later. The original hostname still
 * flows through SNI and the Host header for correct TLS + vhosting.
 */
function pinnedAgent(ip: string, family: 4 | 6): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, _options, cb) => {
        (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, ip, family);
      },
    },
  });
}

function buildHeaders(
  opts: HttpRequestOptions,
  ctx: { stripAuth: boolean; method: HttpMethod; hasBody: boolean; contentType?: string },
): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  if (!h.has("user-agent")) h.set("user-agent", opts.userAgent ?? defaultUserAgent(context.version));
  if (!h.has("accept")) h.set("accept", "*/*");
  if (ctx.stripAuth) {
    h.delete("authorization");
  } else if (opts.basicAuth) {
    const token = Buffer.from(`${opts.basicAuth.username}:${opts.basicAuth.password}`, "utf8").toString("base64");
    h.set("authorization", `Basic ${token}`);
  } else if (opts.bearerToken) {
    h.set("authorization", `Bearer ${opts.bearerToken}`);
  }
  if (ctx.hasBody && !h.has("content-type") && ctx.contentType) {
    h.set("content-type", ctx.contentType);
  }
  // No-body requests must not carry an explicit content-type from a prior hop.
  if (!ctx.hasBody) h.delete("content-type");
  return h;
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
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 504);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Discard a response body without buffering it. Prevents socket leak / OOM. */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // best-effort
  }
}

interface HopResult {
  kind: "response";
  response: HttpResponse;
}
interface HopRedirect {
  kind: "redirect";
  status: number;
  location: string;
}
interface HopError {
  kind: "error";
  response: HttpResponse;
}

/**
 * Per-hop request. Resolves + IP-pins the host, sends the request, and
 * returns either a final response, a redirect instruction, or a failure.
 */
async function sendHop(params: {
  url: string;
  method: HttpMethod;
  body: string | Uint8Array | undefined;
  contentType: string | undefined;
  opts: HttpRequestOptions;
  timeoutMs: number;
  maxBytes: number;
  stripAuth: boolean;
  redirects: string[];
  start: number;
}): Promise<HopResult | HopRedirect | HopError> {
  const { url, method, body, contentType, opts, timeoutMs, maxBytes, stripAuth, redirects, start } = params;
  const parsed = new URL(url);
  const host = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;

  let dispatcher: Agent | undefined;
  if (!opts.allowPrivateHosts) {
    // Literal IP URLs are covered by validateUrl. For hostnames we must
    // resolve and pin so fetch can't race us to a rebound address.
    const literal = /^[0-9.]+$|^[0-9a-f:]+$/i.test(host);
    if (!literal) {
      const resolved = await resolveAndPin(host);
      if (!resolved.ok) return { kind: "error", response: failure(url, resolved.reason, redirects, start) };
      dispatcher = pinnedAgent(resolved.ip, resolved.family);
    }
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(new Error(`request exceeded ${timeoutMs}ms`)), timeoutMs);
  try {
    const hasBody = body !== undefined && method !== "GET" && method !== "HEAD";
    const headers = buildHeaders(opts, { stripAuth, method, hasBody, contentType });
    // node fetch accepts a dispatcher but the field is not in lib.dom RequestInit,
    // and `body` here is always string | Uint8Array which node fetch accepts even
    // though the DOM type is narrower. Cast once at the boundary.
    const fetchInit = {
      method,
      headers,
      body: hasBody ? body : null,
      redirect: "manual" as const,
      signal: abortController.signal,
      ...(dispatcher ? { dispatcher } : {}),
    } as unknown as RequestInit;
    const res = await fetch(url, fetchInit);

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await drain(res);
      const next = new URL(res.headers.get("location")!, url).toString();
      return { kind: "redirect", status: res.status, location: next };
    }

    const respContentType = res.headers.get("content-type") ?? "";
    const decodeText = opts.decodeText ?? shouldDecodeAsText(respContentType);

    let bodyText: string | undefined;
    let bodyBase64: string | undefined;
    let json: unknown;
    let truncated = false;

    if (method === "HEAD") {
      await drain(res);
    } else {
      const { buf, truncated: t } = await readLimitedBody(res, maxBytes, abortController);
      truncated = t;
      if (decodeText) {
        bodyText = decodeBytes(buf, respContentType);
        const ctLower = respContentType.toLowerCase().split(";")[0]!.trim();
        const isJsonCt = ctLower === "application/json" || ctLower.endsWith("+json");
        if (isJsonCt && bodyText.length > 0 && !truncated) {
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
      kind: "response",
      response: {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: res.statusText,
        headers: headersToRecord(res.headers),
        url,
        redirects: [...redirects],
        bodyText,
        bodyBase64,
        json,
        truncated,
        durationMs: Date.now() - start,
      },
    };
  } catch (err) {
    return { kind: "error", response: failure(url, (err as Error).message, redirects, start) };
  } finally {
    clearTimeout(timer);
    if (dispatcher) await dispatcher.close().catch(() => {});
  }
}

/**
 * Top-level HTTP request. Applies SSRF pre-flight, then for each retry
 * attempt runs a fresh follow-redirects loop (so retry state doesn't
 * accumulate across attempts). On cross-origin redirect we strip
 * Authorization headers. On 303 we downgrade to GET; on 301/302 from
 * non-GET/HEAD we also downgrade (WHATWG fetch standard).
 */
export async function httpRequest(opts: HttpRequestOptions): Promise<HttpResponse> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES);
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const retries = Math.max(0, opts.retries ?? 0);

  const urlCheck = validateUrl(opts.url, { allowPrivateHosts: opts.allowPrivateHosts });
  if (!urlCheck.ok) return failure(opts.url, urlCheck.reason ?? "URL rejected", [], start);

  const initialOrigin = new URL(opts.url).origin;
  let lastResponse: HttpResponse | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let currentUrl = opts.url;
    let currentMethod: HttpMethod = opts.method;
    let currentBody: string | Uint8Array | undefined = opts.body;
    let currentContentType = opts.contentType;
    const redirects: string[] = [];
    let hops = 0;

    // Follow redirects for this attempt.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const stripAuth = new URL(currentUrl).origin !== initialOrigin;
      const hop = await sendHop({
        url: currentUrl,
        method: currentMethod,
        body: currentBody,
        contentType: currentContentType,
        opts,
        timeoutMs,
        maxBytes,
        stripAuth,
        redirects,
        start,
      });

      if (hop.kind === "redirect") {
        if (++hops > maxRedirects) {
          return failure(currentUrl, `exceeded ${maxRedirects} redirects`, redirects, start);
        }
        redirects.push(hop.location);
        // Method/body downgrade per WHATWG fetch standard.
        const bodyPreservingMethod = currentMethod === "GET" || currentMethod === "HEAD";
        const downgrade = hop.status === 303 || ((hop.status === 301 || hop.status === 302) && !bodyPreservingMethod);
        if (downgrade) {
          currentMethod = "GET";
          currentBody = undefined;
          currentContentType = undefined;
        }
        currentUrl = hop.location;
        continue;
      }

      // Final response or pre-flight error.
      const res = hop.response;
      if (res.ok) return res;
      if (attempt < retries && isRetryableStatus(res.status)) {
        const delay = parseRetryAfter(res.headers["retry-after"]) ?? Math.min(2 ** attempt * 500, 8000);
        await sleep(delay);
        lastResponse = res;
        break; // next retry attempt
      }
      return res;
    }
  }
  return lastResponse ?? failure(opts.url, "all retries exhausted", [], start);
}

function failure(url: string, error: string, redirects: string[], start: number): HttpResponse {
  return {
    ok: false,
    status: 0,
    statusText: "",
    headers: {},
    url,
    redirects: [...redirects],
    durationMs: Date.now() - start,
    error,
  };
}
