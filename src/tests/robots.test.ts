import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots, robotsPathMatches } from "../tools/robots.js";

describe("parseRobots", () => {
  it("parses groups with user-agents and rules", () => {
    const text = `User-agent: Googlebot
Disallow: /private
Allow: /private/public

User-agent: *
Disallow: /
`;
    const parsed = parseRobots(text);
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[0]?.agents).toEqual(["googlebot"]);
    expect(parsed.groups[0]?.rules).toHaveLength(2);
    expect(parsed.groups[1]?.agents).toEqual(["*"]);
  });

  it("groups multiple User-agent lines together", () => {
    const text = `User-agent: Googlebot
User-agent: Bingbot
Disallow: /admin
`;
    const parsed = parseRobots(text);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.agents).toEqual(["googlebot", "bingbot"]);
    expect(parsed.groups[0]?.rules).toHaveLength(1);
  });

  it("extracts sitemap references", () => {
    const text = `Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/news-sitemap.xml

User-agent: *
Disallow:
`;
    const parsed = parseRobots(text);
    expect(parsed.sitemaps).toEqual(["https://example.com/sitemap.xml", "https://example.com/news-sitemap.xml"]);
  });

  it("ignores comments and blank lines", () => {
    const text = `# Top-level comment
User-agent: *
# inline comment
Disallow: /private # trailing comment
Allow: /
`;
    const parsed = parseRobots(text);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.rules.some((r) => r.path === "/private")).toBe(true);
    expect(parsed.groups[0]?.rules.some((r) => r.path === "/")).toBe(true);
  });

  it("captures Crawl-delay", () => {
    const text = `User-agent: *
Crawl-delay: 10
Disallow: /
`;
    const parsed = parseRobots(text);
    expect(parsed.groups[0]?.crawlDelay).toBe(10);
  });

  it("preserves empty Disallow as no-op", () => {
    const text = `User-agent: Bot
Disallow:
`;
    const parsed = parseRobots(text);
    // Rule is recorded (spec-compliant) but it must not match any real path.
    expect(parsed.groups[0]?.rules).toHaveLength(1);
    expect(parsed.groups[0]?.rules[0]?.path).toBe("");
    expect(isAllowed(parsed, "Bot", "/anything").allowed).toBe(true);
  });
});

describe("isAllowed", () => {
  const robots = parseRobots(`User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /api/*.json$
`);

  it("allows public paths by default", () => {
    expect(isAllowed(robots, "SomeBot", "/").allowed).toBe(true);
    expect(isAllowed(robots, "SomeBot", "/about").allowed).toBe(true);
  });

  it("denies disallowed paths", () => {
    const v = isAllowed(robots, "SomeBot", "/private/secret");
    expect(v.allowed).toBe(false);
    expect(v.rule).toContain("Disallow");
  });

  it("longest-match allow overrides shorter disallow", () => {
    const v = isAllowed(robots, "SomeBot", "/private/public/page");
    expect(v.allowed).toBe(true);
  });

  it("handles anchored $ end-of-path", () => {
    const jsonDenied = isAllowed(robots, "SomeBot", "/api/items.json");
    expect(jsonDenied.allowed).toBe(false);
    // Same prefix but different extension should NOT match the anchored pattern
    const xmlAllowed = isAllowed(robots, "SomeBot", "/api/items.xml");
    expect(xmlAllowed.allowed).toBe(true);
  });

  it("picks specific group over wildcard when agent matches", () => {
    const text = `User-agent: Googlebot
Disallow:

User-agent: *
Disallow: /
`;
    const r = parseRobots(text);
    expect(isAllowed(r, "Googlebot/2.1", "/anything").allowed).toBe(true);
    expect(isAllowed(r, "SomeOtherBot", "/anything").allowed).toBe(false);
  });

  it("returns allowed=true when no group matches at all", () => {
    const r = parseRobots("");
    expect(isAllowed(r, "Bot", "/").allowed).toBe(true);
  });

  it("picks the group matching the longest specific UA token, not the group's first agent", () => {
    // Two groups both match "googlebot-news". The old code compared against
    // the group's first-agent length and picked the wrong group.
    const text = `User-agent: googlebot
User-agent: bingbot
Disallow: /wrong

User-agent: googlebot-news
Disallow: /right
`;
    const r = parseRobots(text);
    const v = isAllowed(r, "Googlebot-News/1.0", "/right/page");
    expect(v.allowed).toBe(false);
    expect(v.rule).toContain("/right");
  });

  it("Allow beats Disallow when paths are the same length", () => {
    const r = parseRobots(`User-agent: *
Disallow: /x
Allow: /x
`);
    expect(isAllowed(r, "Bot", "/x").allowed).toBe(true);
  });
});

/**
 * The RegExp matcher `robotsPathMatches` replaced (through 0.8.3). It is the
 * reference semantics: the linear matcher must agree with it on every input
 * it can evaluate in reasonable time.
 */
function regexOracle(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const raw = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}${anchored ? "$" : ""}`);
  return re.test(path);
}

/** Deterministic PRNG (mulberry32) so the differential sample is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("robotsPathMatches", () => {
  const cases: Array<[string, string, boolean]> = [
    ["", "/", false],
    ["", "", false],
    ["/", "/", true],
    ["/", "", false],
    ["/foo", "/foo/bar", true],
    ["/foo", "/fo", false],
    ["/foo$", "/foo", true],
    ["/foo$", "/foo/", false],
    ["$", "", true],
    ["$", "/", false],
    ["*", "", true],
    ["*$", "/any", true],
    ["*$", "/a\nb", false],
    ["/a$b", "/a$b/c", true],
    ["/a$b$", "/a$b", true],
    ["/a$$", "/a$", true],
    ["/a$$", "/a", false],
    ["/*.json$", "/x.json", true],
    ["/*.json$", "/x.json?y", false],
    ["/*.json", "/x.json?y", true],
    ["/*.json", "/xjson", false],
    ["/a*b*c", "/abc", true],
    ["/a*b*c", "/acb", false],
    ["/a**b", "/ab", true],
    ["/a*a$", "/aa", true],
    ["/a*a$", "/a", false],
    ["/a*ba$", "/aba", true],
    ["/a*ba$", "/ababa", true],
    ["/a*b", "/a\nb", false],
    ["/a*b", "/ab\nb", true],
    ["/a*\nb", "/ax\nb", true],
    ["/a*\nb", "/a\nx\nb", false],
    ["/a*b", "/a\u2028b", false],
    ["/a*b", "/a\rb", false],
    ["/%2F*", "/%2Fx", true],
    ["/%2f", "/%2F", false],
    ["/[a](b)+?{1}|^.\\", "/[a](b)+?{1}|^.\\z", true],
    ["/[a]", "/a", false],
  ];
  it.each(cases)("pattern %j against %j -> %s", (pattern, path, expected) => {
    expect(robotsPathMatches(pattern, path)).toBe(expected);
    expect(regexOracle(pattern, path)).toBe(expected);
  });

  it("agrees with the old RegExp matcher on a randomized sample", () => {
    const patternAlphabet = ["*", "*", "$", "%", "/", "-", "a", "b", ".", "\n", "2"];
    const pathAlphabet = ["*", "$", "%", "/", "-", "a", "a", "b", "b", ".", "\n", "\r", "2"];
    const rand = rng(0x5eed);
    const pick = (alphabet: string[], max: number) => {
      const len = Math.floor(rand() * (max + 1));
      let out = "";
      for (let i = 0; i < len; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
      return out;
    };
    let matched = 0;
    for (let i = 0; i < 20_000; i++) {
      const pattern = pick(patternAlphabet, 8);
      // Bias toward paths that share the pattern's literal prefix, or almost
      // every sample is a trivial first-character mismatch.
      const path =
        rand() < 0.5
          ? pattern.replace(/[*$]/g, () => pick(pathAlphabet, 3)) + pick(pathAlphabet, 3)
          : pick(pathAlphabet, 10);
      const expected = regexOracle(pattern, path);
      if (expected) matched++;
      if (robotsPathMatches(pattern, path) !== expected) {
        throw new Error(
          `mismatch: pattern ${JSON.stringify(pattern)} path ${JSON.stringify(path)} expected ${expected}`,
        );
      }
    }
    // The sample must exercise both outcomes, not just rejections.
    expect(matched).toBeGreaterThan(2_000);
  });

  it("does not throw on a pattern too large to compile as a RegExp", () => {
    const pattern = `${"*a".repeat(100_000)}`;
    expect(() => regexOracle(pattern, "/a")).toThrow();
    const t0 = performance.now();
    expect(robotsPathMatches(pattern, "/a")).toBe(false);
    expect(robotsPathMatches(pattern, `/${"a".repeat(100_000)}`)).toBe(true);
    const r = parseRobots(`User-agent: *\nDisallow: ${pattern}\n`);
    expect(isAllowed(r, "Bot", "/a").allowed).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("matches many-wildcard rules against a hyphenated slug in linear time", () => {
    // 20 rules of 10 wildcards each backtracked C(hyphens, 10) ways per rule
    // under the RegExp matcher: ~12 s on this slug.
    const rules = Array.from({ length: 20 }, (_, i) => `Disallow: /${"*-".repeat(10)}X${i}$`).join("\n");
    const r = parseRobots(`User-agent: *\n${rules}\n`);
    const slug =
      "how-to-make-the-best-of-a-long-weekend-in-the-city-with-your-kids-and-friends-on-a-budget-in-2026-guide";
    const t0 = performance.now();
    expect(isAllowed(r, "Bot", `/blog/${slug}`).allowed).toBe(true);
    expect(isAllowed(r, "Bot", `/blog/${slug}-X7`)).toEqual({
      allowed: false,
      rule: `Disallow: /${"*-".repeat(10)}X7$`,
    });
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
