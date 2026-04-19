import { isIP } from "node:net";

// IANA-reserved, loopback, link-local, multicast, and cloud-metadata
// ranges. Refusing these at request time stops SSRF abuse where a model
// is coaxed into hitting internal infrastructure.
const BLOCKED_IPV4_CIDRS: Array<[number, number]> = [
  cidr("0.0.0.0", 8), //      "this network"
  cidr("10.0.0.0", 8), //     RFC 1918 private
  cidr("100.64.0.0", 10), //  CGNAT
  cidr("127.0.0.0", 8), //    loopback
  cidr("169.254.0.0", 16), // link-local + AWS/GCP/Azure metadata (169.254.169.254)
  cidr("172.16.0.0", 12), //  RFC 1918 private
  cidr("192.0.0.0", 24), //   IETF protocol assignments
  cidr("192.0.2.0", 24), //   TEST-NET-1
  cidr("192.168.0.0", 16), // RFC 1918 private
  cidr("198.18.0.0", 15), //  benchmarking
  cidr("198.51.100.0", 24), // TEST-NET-2
  cidr("203.0.113.0", 24), // TEST-NET-3
  cidr("224.0.0.0", 4), //    multicast
  cidr("240.0.0.0", 4), //    reserved
  cidr("255.255.255.255", 32), // broadcast
];

const BLOCKED_IPV6_PREFIXES = [
  "::", //         unspecified
  "::1", //        loopback
  "fc", //         fc00::/7 unique-local (covers fc/fd)
  "fd", //
  "fe80", //       fe80::/10 link-local
  "ff", //         ff00::/8 multicast
  "::ffff:", //    IPv4-mapped (we'll extract and re-check the IPv4)
  "64:ff9b:", //   NAT64
  "2001:db8:", //  documentation
];

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function cidr(base: string, bits: number): [number, number] {
  const parts = base.split(".").map((n) => Number.parseInt(n, 10));
  const ip = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return [ip & mask, mask];
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out >>> 0;
}

/**
 * Check whether an IP literal (v4 or v6) lives in a blocked range.
 * Returns a human-readable reason when blocked, or null when fine.
 */
export function checkIpAddress(ip: string): string | null {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return "invalid IPv4 literal";
    for (const [base, mask] of BLOCKED_IPV4_CIDRS) {
      if ((n & mask) === base) return `IPv4 address ${ip} is in a reserved/private range`;
    }
    return null;
  }
  if (kind === 6) {
    const normalized = ip.toLowerCase();
    // Strip zone id (fe80::1%eth0)
    const bare = normalized.split("%")[0]!;
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the IPv4 half
    const v4MappedMatch = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4MappedMatch) return checkIpAddress(v4MappedMatch[1]!);
    for (const prefix of BLOCKED_IPV6_PREFIXES) {
      if (bare === prefix || bare.startsWith(`${prefix}:`) || bare.startsWith(prefix)) {
        return `IPv6 address ${ip} is in a reserved/private range`;
      }
    }
    return null;
  }
  return `"${ip}" is not a valid IP literal`;
}

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a URL before we send a request. Rejects:
 *  - non-http(s) schemes (file://, gopher://, ftp://, data:, javascript:, etc.)
 *  - hostnames that are literal private/loopback IPs
 *  - obvious cloud-metadata endpoints
 *
 * Hostname DNS resolution is NOT done here — callers that want
 * resolution-time protection should do a DNS lookup and re-run
 * checkIpAddress on each resolved address, refusing the request if any
 * resolves into a blocked range. That covers DNS-rebinding abuse; the
 * URL-only check here covers direct literals.
 */
export function validateUrl(raw: string, opts: { allowPrivateHosts?: boolean } = {}): SsrfCheckResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "URL failed to parse" };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, reason: `scheme "${url.protocol}" is not allowed (only http/https)` };
  }
  if (opts.allowPrivateHosts) return { ok: true };

  const hostname = url.hostname;
  if (!hostname) return { ok: false, reason: "URL has no hostname" };

  // Strip brackets off IPv6 literals
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  if (isIP(bare) !== 0) {
    const reason = checkIpAddress(bare);
    if (reason) return { ok: false, reason };
  }
  // Named "localhost" is a common trap — refuse even though DNS could map it anywhere
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: `hostname "${hostname}" resolves to loopback` };
  }
  return { ok: true };
}

export function defaultUserAgent(version: string): string {
  return `@yawlabs/fetch-mcp/${version} (+https://github.com/YawLabs/fetch-mcp)`;
}
