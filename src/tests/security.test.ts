import { describe, expect, it } from "vitest";
import { checkIpAddress, defaultUserAgent, validateUrl } from "../security.js";

describe("checkIpAddress", () => {
  it("blocks IPv4 loopback", () => {
    expect(checkIpAddress("127.0.0.1")).toMatch(/reserved/);
    expect(checkIpAddress("127.255.255.255")).toMatch(/reserved/);
  });

  it("blocks RFC1918 private ranges", () => {
    expect(checkIpAddress("10.0.0.1")).toMatch(/reserved/);
    expect(checkIpAddress("172.16.5.5")).toMatch(/reserved/);
    expect(checkIpAddress("172.31.255.255")).toMatch(/reserved/);
    expect(checkIpAddress("192.168.1.1")).toMatch(/reserved/);
  });

  it("blocks link-local and cloud-metadata", () => {
    expect(checkIpAddress("169.254.169.254")).toMatch(/reserved/);
    expect(checkIpAddress("169.254.0.1")).toMatch(/reserved/);
  });

  it("blocks CGNAT range", () => {
    expect(checkIpAddress("100.64.0.1")).toMatch(/reserved/);
    expect(checkIpAddress("100.127.255.255")).toMatch(/reserved/);
  });

  it("blocks multicast and broadcast", () => {
    expect(checkIpAddress("224.0.0.1")).toMatch(/reserved/);
    expect(checkIpAddress("239.255.255.250")).toMatch(/reserved/);
    expect(checkIpAddress("255.255.255.255")).toMatch(/reserved/);
  });

  it("allows public IPv4", () => {
    expect(checkIpAddress("8.8.8.8")).toBeNull();
    expect(checkIpAddress("1.1.1.1")).toBeNull();
    expect(checkIpAddress("93.184.216.34")).toBeNull();
  });

  it("blocks IPv6 loopback and unspecified", () => {
    expect(checkIpAddress("::1")).toMatch(/loopback/);
    expect(checkIpAddress("::")).toMatch(/unspecified/);
  });

  it("blocks IPv6 unique-local and link-local", () => {
    expect(checkIpAddress("fc00::1")).toMatch(/unique-local/);
    expect(checkIpAddress("fd12:3456:789a::1")).toMatch(/unique-local/);
    expect(checkIpAddress("fe80::1")).toMatch(/link-local/);
  });

  it("blocks the full fe80::/10 link-local range, not just fe80::/16", () => {
    // The /10 covers fe80::-febf::, so fe85, fe9*, fea*, feb* are all link-local.
    // A previous string-prefix check only caught fe80*, leaving the rest open as
    // an SSRF target. These guard against regressing back to that.
    expect(checkIpAddress("fe85::1")).toMatch(/link-local/);
    expect(checkIpAddress("fe9f::1")).toMatch(/link-local/);
    expect(checkIpAddress("fea0::1")).toMatch(/link-local/);
    expect(checkIpAddress("febf::1")).toMatch(/link-local/);
    // fec0:: is just outside the /10 — no longer link-local (deprecated site-local).
    expect(checkIpAddress("fec0::1")).toBeNull();
  });

  it("blocks IPv6 multicast and documentation prefixes", () => {
    expect(checkIpAddress("ff02::1")).toMatch(/multicast/);
    expect(checkIpAddress("2001:db8::1")).toMatch(/documentation/);
    expect(checkIpAddress("64:ff9b::1.2.3.4")).toMatch(/NAT64/);
  });

  it("blocks IPv4-mapped IPv6 that targets private v4", () => {
    expect(checkIpAddress("::ffff:127.0.0.1")).toMatch(/maps to 127\.0\.0\.1/);
    expect(checkIpAddress("::ffff:169.254.169.254")).toMatch(/maps to 169\.254\.169\.254/);
  });

  it("blocks IPv4-mapped IPv6 written in hex form", () => {
    // ::ffff:7f00:1 is the hex form of ::ffff:127.0.0.1. The previous code only
    // matched the dotted-quad form via regex, so an attacker who knew the hex
    // form could route around the v4 block list.
    expect(checkIpAddress("::ffff:7f00:1")).toMatch(/maps to 127\.0\.0\.1/);
    expect(checkIpAddress("::ffff:a9fe:a9fe")).toMatch(/maps to 169\.254\.169\.254/);
  });

  it("allows public IPv4 wrapped in IPv4-mapped IPv6 (any form)", () => {
    expect(checkIpAddress("::ffff:8.8.8.8")).toBeNull();
    expect(checkIpAddress("::ffff:0808:0808")).toBeNull();
  });

  it("allows public IPv6", () => {
    expect(checkIpAddress("2606:4700:4700::1111")).toBeNull();
  });

  it("returns an error for non-IP strings", () => {
    expect(checkIpAddress("not-an-ip")).toMatch(/not a valid IP/);
  });
});

describe("validateUrl", () => {
  it("rejects non-http schemes", () => {
    expect(validateUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateUrl("gopher://example.com").ok).toBe(false);
    expect(validateUrl("ftp://example.com/file").ok).toBe(false);
    expect(validateUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateUrl("data:text/plain,hello").ok).toBe(false);
  });

  it("rejects literal private hostnames", () => {
    expect(validateUrl("http://127.0.0.1/").ok).toBe(false);
    expect(validateUrl("http://10.0.0.1/").ok).toBe(false);
    expect(validateUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
    expect(validateUrl("http://[::1]/").ok).toBe(false);
    expect(validateUrl("http://[fc00::1]/").ok).toBe(false);
  });

  it("rejects localhost by name", () => {
    expect(validateUrl("http://localhost/").ok).toBe(false);
    expect(validateUrl("http://api.localhost/").ok).toBe(false);
  });

  it("allows public hosts", () => {
    expect(validateUrl("https://example.com/").ok).toBe(true);
    expect(validateUrl("https://api.github.com/users/octocat").ok).toBe(true);
    expect(validateUrl("http://8.8.8.8/").ok).toBe(true);
  });

  it("returns ok when allowPrivateHosts is set", () => {
    expect(validateUrl("http://127.0.0.1/", { allowPrivateHosts: true }).ok).toBe(true);
    expect(validateUrl("http://localhost/", { allowPrivateHosts: true }).ok).toBe(true);
  });

  it("rejects unparseable URLs", () => {
    expect(validateUrl("not-a-url").ok).toBe(false);
    expect(validateUrl("").ok).toBe(false);
  });
});

describe("defaultUserAgent", () => {
  it("includes package name, version, and repo link", () => {
    const ua = defaultUserAgent("1.2.3");
    expect(ua).toContain("@yawlabs/fetch-mcp");
    expect(ua).toContain("1.2.3");
    expect(ua).toContain("github.com/YawLabs/fetch-mcp");
  });
});
