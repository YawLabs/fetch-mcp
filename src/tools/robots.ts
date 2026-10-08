import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import type { HttpRequester } from "../http.js";
import { ALLOW_PRIVATE_HOSTS_DESCRIPTION } from "../policy.js";

interface Group {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
  crawlDelay?: number;
}

export interface RobotsParsed {
  groups: Group[];
  sitemaps: string[];
}

/**
 * Parse the text of a robots.txt into structured rules.
 *
 * Line shape: `field: value`, case-insensitive on field; blank lines close
 * a group; lines starting with `#` are comments. A group attaches to every
 * preceding User-agent line that wasn't interrupted by a rule or blank line.
 *
 * Per RFC 9309, an empty `Disallow:` value is the canonical "nothing is
 * disallowed" marker and MUST be preserved (not silently dropped).
 */
export function parseRobots(text: string): RobotsParsed {
  const sitemaps: string[] = [];
  const groups: Group[] = [];
  let current: Group | null = null;
  let collectingAgents = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) {
      // Truly blank line closes the current group
      current = null;
      collectingAgents = false;
      continue;
    }
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue; // comment-only line -- skip, but do NOT close the group
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Sitemap always needs a value
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!value) continue;
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) {
      current = { agents: ["*"], rules: [] };
      groups.push(current);
    }
    collectingAgents = false;
    if (field === "allow") {
      if (value) current.rules.push({ allow: true, path: value });
    } else if (field === "disallow") {
      // Empty Disallow: "" -- per spec, a no-op that explicitly allows
      // everything in this group. We record it so callers can see it came
      // from the file, but it never matches a non-empty path.
      current.rules.push({ allow: false, path: value });
    } else if (field === "crawl-delay") {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

/**
 * Pick the group whose most-specific (longest) agent token is a substring
 * of the caller's UA. Falls back to the wildcard group `*` if no specific
 * group matches. When two groups both specify the same UA, the one whose
 * specific-agent token is longest wins.
 */
function pickGroup(parsed: RobotsParsed, userAgent: string): Group | null {
  const ua = userAgent.toLowerCase();
  let bestSpecific: { group: Group; tokenLen: number } | null = null;
  let wildcard: Group | null = null;
  for (const g of parsed.groups) {
    for (const a of g.agents) {
      if (a === "*") {
        wildcard = wildcard ?? g;
      } else if (ua.includes(a)) {
        if (!bestSpecific || a.length > bestSpecific.tokenLen) {
          bestSpecific = { group: g, tokenLen: a.length };
        }
      }
    }
  }
  return bestSpecific?.group ?? wildcard;
}

/**
 * Google-style match: "/foo" matches anything starting with /foo.
 * `$` means end-of-path. `*` is a glob placeholder.
 * Empty pattern never matches (per RFC 9309 "Disallow:" is a no-op).
 *
 * Linear matcher, never a RegExp. The pattern is attacker-chosen (it comes
 * from the fetched robots.txt): compiling it to `^a.*b.*c$` let one rule
 * throw "regular expression too large" out of the tool, and twenty rules
 * like `/*-*-*-*-*-*-*-*-*-*-X$` backtracked for seconds against one
 * hyphenated slug. Semantics are exactly those of the RegExp it replaces
 * (pinned by a differential test): `^` + literal segments joined by `.*`,
 * plus `$` only when the pattern ends with `$` (a `$` elsewhere is
 * literal). Like `.`, a `*` never spans a line terminator (\n, \r,
 * U+2028, U+2029); no percent-encoding normalization is applied.
 *
 * Each literal segment is placed at its leftmost occurrence whose gap from
 * the previous segment holds no line terminator. Leftmost is optimal: a
 * later occurrence leaves less of the path and its gap contains the
 * leftmost one's, so it can never succeed where the leftmost fails.
 */
export function robotsPathMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const raw = anchored ? pattern.slice(0, -1) : pattern;
  const segments = raw.split("*");
  const first = segments[0] as string;
  if (segments.length === 1) return anchored ? path === first : path.startsWith(first);
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  const last = segments.length - 1;
  // A `*` may cover [pos, limit): it stops at the next line terminator.
  // `pos` only grows, so the cached limit stays right until `pos` passes it,
  // which keeps the terminator scan linear over the whole match.
  let limit = -1;
  for (let k = 1; k <= last; k++) {
    const seg = segments[k] as string;
    if (pos > limit) limit = nextLineTerminator(path, pos);
    if (k === last && anchored) {
      const at = path.length - seg.length;
      return at >= pos && at <= limit && path.endsWith(seg);
    }
    const at = path.indexOf(seg, pos);
    if (at < 0 || at > limit) return false;
    pos = at + seg.length;
  }
  return true;
}

/** The characters `.` excludes, which a `*` therefore cannot cover. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;

/**
 * Index of the first `.`-excluded line terminator at or after `from`, else
 * `path.length`. A native scan: a charCode loop here ran once per rule over
 * the rest of the path and made `/*.pdf$`-style rules ~4x slower than the old
 * RegExp matcher on a robots.txt of 35,000 of them.
 */
function nextLineTerminator(path: string, from: number): number {
  LINE_TERMINATOR.lastIndex = from;
  const m = LINE_TERMINATOR.exec(path);
  return m ? m.index : path.length;
}

export function isAllowed(parsed: RobotsParsed, userAgent: string, path: string): { allowed: boolean; rule?: string } {
  const group = pickGroup(parsed, userAgent);
  if (!group) return { allowed: true };
  // Longest-match rule wins. When lengths tie, Allow beats Disallow.
  let best: { allow: boolean; path: string } | null = null;
  for (const r of group.rules) {
    if (!robotsPathMatches(r.path, path)) continue;
    if (!best) {
      best = r;
      continue;
    }
    if (r.path.length > best.path.length) best = r;
    else if (r.path.length === best.path.length && r.allow && !best.allow) best = r;
  }
  if (!best) return { allowed: true };
  return { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` };
}

export function registerRobotsTools(server: McpServer, request: HttpRequester) {
  server.tool(
    "fetch_robots",
    "Fetch and parse the robots.txt for a given origin, then tell the caller whether a target URL is crawlable by a given user-agent. Follows the Google-style longest-match rule with Allow-wins-on-tie. Returns the raw robots.txt, parsed groups, sitemap references, and the allow/deny verdict with the matching rule.",
    {
      url: z.string().url().describe("Target URL to check. We derive origin + path automatically."),
      user_agent: z.string().optional().describe("User-agent string to match against groups (default '*')"),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      max_redirects: z.number().int().min(0).max(20).optional(),
      allow_private_hosts: z.boolean().optional().describe(ALLOW_PRIVATE_HOSTS_DESCRIPTION),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, user_agent, timeout_ms, max_redirects, allow_private_hosts }, extra) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return formatError("URL failed to parse");
      }
      const robotsUrl = `${parsed.origin}/robots.txt`;
      const res = await request({
        signal: extra.signal,
        method: "GET",
        url: robotsUrl,
        timeoutMs: timeout_ms,
        maxBytes: 512 * 1024,
        maxRedirects: max_redirects,
        allowPrivateHosts: allow_private_hosts,
        decodeText: true,
      });
      if (res.error) return formatError(res.error);
      const ua = user_agent ?? "*";
      const path = parsed.pathname + parsed.search;
      // 404 means "no rules -- everything allowed" per the spec. It returns the
      // same keys as the parsed path below (see README `fetch_robots`), because
      // a site with no robots.txt is the common case, and a caller reading
      // `sitemaps` or `path` off the documented shape must not get undefined.
      if (res.status === 404) {
        return formatJson({
          robotsUrl,
          status: 404,
          userAgent: ua,
          path,
          allowed: true,
          matchedRule: null,
          crawlDelay: null,
          sitemaps: [],
          rawRobotsText: "",
          note: "no robots.txt -- crawl permitted by default",
        });
      }
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText} fetching ${robotsUrl}`);
      const rawRobotsText = res.bodyText ?? "";
      const robots = parseRobots(rawRobotsText);
      const verdict = isAllowed(robots, ua, path);
      return formatJson({
        robotsUrl,
        status: res.status,
        userAgent: ua,
        path,
        allowed: verdict.allowed,
        matchedRule: verdict.rule ?? null,
        crawlDelay: pickGroup(robots, ua)?.crawlDelay ?? null,
        sitemaps: robots.sitemaps,
        rawRobotsText,
      });
    },
  );
}
