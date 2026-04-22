import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "../tools/robots.js";

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
