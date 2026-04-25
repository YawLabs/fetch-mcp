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
 * Expand any valid IPv6 textual form (compressed `::`, IPv4-mapped dotted-quad,
 * lowercase or uppercase hex) into its 16 raw bytes. Returns null on malformed
 * input. Strips an optional `%zone` suffix.
 */
function ipv6ToBytes(ip: string): Uint8Array | null {
  const bare = ip.split("%")[0]!.toLowerCase();
  // If a dotted-quad tail is present (IPv4-mapped or IPv4-compatible), convert
  // it to two trailing hextets so the parser below sees a uniform shape.
  let normalized = bare;
  const dotMatch = bare.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotMatch) {
    const a = Number.parseInt(dotMatch[2]!, 10);
    const b = Number.parseInt(dotMatch[3]!, 10);
    const c = Number.parseInt(dotMatch[4]!, 10);
    const d = Number.parseInt(dotMatch[5]!, 10);
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    normalized = `${dotMatch[1]}${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const total = left.length + right.length;
  if (total > 8) return null;
  if (halves.length === 1 && total !== 8) return null;
  const zeros = halves.length === 2 ? 8 - total : 0;
  const hextets = [...left, ...new Array<string>(zeros).fill("0"), ...right];
  if (hextets.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const h = hextets[i]!;
    if (h.length === 0 || h.length > 4 || !/^[0-9a-f]+$/.test(h)) return null;
    const n = Number.parseInt(h, 16);
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function allBytesZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
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
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return `"${ip}" is not a valid IPv6 literal`;

    // IPv4-mapped (::ffff:0:0/96) -- recheck the embedded IPv4. Detected on the
    // raw bytes so both the dotted-quad form (::ffff:127.0.0.1) and the hex
    // form (::ffff:7f00:1) are caught. Without this an attacker who knows the
    // hex form could route around our v4 block list.
    if (allBytesZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
      const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      const reason = checkIpAddress(v4);
      return reason ? `IPv6 address ${ip} maps to ${v4}: ${reason}` : null;
    }

    // ::1 loopback
    if (allBytesZero(bytes, 0, 15) && bytes[15] === 1) {
      return `IPv6 address ${ip} is loopback (::1)`;
    }
    // :: unspecified
    if (allBytesZero(bytes, 0, 16)) {
      return `IPv6 address ${ip} is unspecified (::)`;
    }
    // fc00::/7 unique-local (covers fc00::-fdff::)
    if ((bytes[0]! & 0xfe) === 0xfc) {
      return `IPv6 address ${ip} is unique-local (fc00::/7)`;
    }
    // fe80::/10 link-local (covers fe80::-febf::, the full /10 not just fe80::/16)
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) {
      return `IPv6 address ${ip} is link-local (fe80::/10)`;
    }
    // ff00::/8 multicast
    if (bytes[0] === 0xff) {
      return `IPv6 address ${ip} is multicast (ff00::/8)`;
    }
    // 2001:db8::/32 documentation
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
      return `IPv6 address ${ip} is documentation (2001:db8::/32)`;
    }
    // 64:ff9b::/96 NAT64 (well-known prefix; could be used to reach internal v4 via a translator)
    if (
      bytes[0] === 0x00 &&
      bytes[1] === 0x64 &&
      bytes[2] === 0xff &&
      bytes[3] === 0x9b &&
      allBytesZero(bytes, 4, 12)
    ) {
      return `IPv6 address ${ip} is NAT64 (64:ff9b::/96)`;
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
