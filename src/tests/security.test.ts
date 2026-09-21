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

  it("blocks the Azure WireServer address, and only that address in its /16", () => {
    // 168.63.129.16 looks public but is the Azure host agent on every VM.
    expect(checkIpAddress("168.63.129.16")).toMatch(/reserved/);
    expect(checkIpAddress("168.63.129.15")).toBeNull();
    expect(checkIpAddress("168.63.129.17")).toBeNull();
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
    // fec0:: is just outside the /10 -- not link-local, but deprecated site-local,
    // blocked by its own rule since 0.7.2.
    expect(checkIpAddress("fec0::1")).toMatch(/site-local/);
    expect(checkIpAddress("fec0::1")).not.toMatch(/link-local/);
    // ...and site-local is the whole /10 (fec0::-feff::), not just fec0::/16.
    expect(checkIpAddress("fed0::1")).toMatch(/site-local/);
    expect(checkIpAddress("feff:ffff::1")).toMatch(/site-local/);
  });

  describe("IPv6 forms that embed or tunnel to IPv4 (0.7.2)", () => {
    // Each of these passed checkIpAddress (and so validateUrl and the DNS
    // answer check) before 0.7.2.
    it("rechecks the IPv4 inside IPv4-compatible addresses (::a.b.c.d, ::/96)", () => {
      // new URL("http://[::127.0.0.1]/") normalises the host to [::7f00:1].
      expect(checkIpAddress("::7f00:1")).toMatch(/IPv4-compatible\) embeds 127\.0\.0\.1/);
      expect(checkIpAddress("::127.0.0.1")).toMatch(/embeds 127\.0\.0\.1/);
      expect(checkIpAddress("::a9fe:a9fe")).toMatch(/embeds 169\.254\.169\.254/);
      expect(checkIpAddress("::8.8.8.8")).toBeNull();
    });

    it("rechecks the IPv4 inside IPv4-translated (SIIT) addresses (::ffff:0:0:0/96)", () => {
      expect(checkIpAddress("::ffff:0:7f00:1")).toMatch(/IPv4-translated\) embeds 127\.0\.0\.1/);
      expect(checkIpAddress("::ffff:0:a00:1")).toMatch(/embeds 10\.0\.0\.1/);
      expect(checkIpAddress("::ffff:0:808:808")).toBeNull();
    });

    it("rechecks the IPv4 tunnel endpoint inside 6to4 addresses (2002::/16)", () => {
      expect(checkIpAddress("2002:a00:1::1")).toMatch(/6to4\) embeds 10\.0\.0\.1/);
      expect(checkIpAddress("2002:7f00:1::1")).toMatch(/embeds 127\.0\.0\.1/);
      expect(checkIpAddress("2002:a9fe:a9fe::1")).toMatch(/embeds 169\.254\.169\.254/);
      expect(checkIpAddress("2002:808:808::1")).toBeNull();
    });

    it("blocks Teredo (2001::/32) outright, without catching the rest of 2001::/16", () => {
      expect(checkIpAddress("2001::1")).toMatch(/Teredo/);
      expect(checkIpAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toMatch(/Teredo/);
      expect(checkIpAddress("2001:0:ffff:ffff::1")).toMatch(/Teredo/);
      // The /32 boundary: 2001:1:: is the next /32 over (PCP anycast, globally
      // reachable), and Google Public DNS lives in 2001:4860::/32.
      expect(checkIpAddress("2001:1::1")).toBeNull();
      expect(checkIpAddress("2001:4860:4860::8888")).toBeNull();
    });

    it("blocks local-use NAT64 (64:ff9b:1::/48) alongside the well-known prefix", () => {
      expect(checkIpAddress("64:ff9b:1::a00:1")).toMatch(/local-use NAT64/);
      expect(checkIpAddress("64:ff9b:1:ffff::1")).toMatch(/local-use NAT64/);
      // Just outside the /48 -- still refused, by the global-unicast allow-list.
      expect(checkIpAddress("64:ff9b:2::1")).toMatch(/outside global unicast/);
    });

    it("blocks discard-only (100::/64) by name; the rest of 100::/8 falls to the global-unicast allow-list", () => {
      expect(checkIpAddress("100::1")).toMatch(/discard-only/);
      expect(checkIpAddress("100:0:0:1::1")).toMatch(/outside global unicast/);
    });
  });

  describe("IPv6 global-unicast allow-list (0.7.2)", () => {
    it("refuses everything outside 2000::/3 that no named rule caught", () => {
      // IANA: 5f00::/16 SRv6 SIDs, 100:0:0:1::/64 dummy prefix, and unassigned space.
      for (const ip of ["5f00::1", "100:0:0:1::1", "4000::1", "1000::1", "8000::1", "fe00::1", "c000::1"]) {
        expect(checkIpAddress(ip), ip).toMatch(/outside global unicast \(2000::\/3\)/);
      }
    });

    it("refuses the non-global blocks inside 2000::/3", () => {
      expect(checkIpAddress("3fff::1")).toMatch(/documentation \(3fff::\/20\)/);
      expect(checkIpAddress("3fff:fff::1")).toMatch(/documentation/);
      expect(checkIpAddress("2001:2::1")).toMatch(/benchmarking/);
      expect(checkIpAddress("2001:2:0:ffff::1")).toMatch(/benchmarking/);
      expect(checkIpAddress("2001:10::1")).toMatch(/ORCHID/);
      expect(checkIpAddress("2001:1f::1")).toMatch(/ORCHID/);
    });

    it("keeps global unicast open, right up to the edges of those blocks", () => {
      for (const ip of [
        "2000::1",
        "2606:4700:4700::1111",
        "2a00:1450:4001::1",
        "3ffe::1",
        "3fff:1000::1", // just past 3fff::/20
        "2001:3::1", // just past 2001:2::/48 (AMT, globally reachable)
        "2001:20::1", // just past 2001:10::/28 (ORCHIDv2, globally reachable)
      ]) {
        expect(checkIpAddress(ip), ip).toBeNull();
      }
    });

    it("leaves the embedding forms to their own rules (public embedded IPv4 stays allowed)", () => {
      // ::/96, SIIT and mapped sit outside 2000::/3 but are decided earlier.
      expect(checkIpAddress("::8.8.8.8")).toBeNull();
      expect(checkIpAddress("::ffff:8.8.8.8")).toBeNull();
      expect(checkIpAddress("::ffff:0:808:808")).toBeNull();
    });

    it("reaches validateUrl: a literal URL in any of these forms is refused", () => {
      for (const host of [
        "[::127.0.0.1]",
        "[::ffff:0:7f00:1]",
        "[2002:a00:1::1]",
        "[2001::1]",
        "[64:ff9b:1::a00:1]",
        "[fec0::1]",
        "[100::1]",
      ]) {
        const res = validateUrl(`http://${host}:8080/`);
        expect(res.ok, host).toBe(false);
      }
      expect(validateUrl("http://[2001:4860:4860::8888]/").ok).toBe(true);
    });
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
