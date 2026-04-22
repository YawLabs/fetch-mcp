import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError, formatJson } from "../format.js";
import { httpRequest } from "../http.js";

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
 */
function robotsPathMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const raw = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}${anchored ? "$" : ""}`);
  return re.test(path);
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

export function registerRobotsTools(server: McpServer) {
  server.tool(
    "fetch_robots",
    "Fetch and parse the robots.txt for a given origin, then tell the caller whether a target URL is crawlable by a given user-agent. Follows the Google-style longest-match rule with Allow-wins-on-tie. Returns the raw robots.txt, parsed groups, sitemap references, and the allow/deny verdict with the matching rule.",
    {
      url: z.string().url().describe("Target URL to check. We derive origin + path automatically."),
      user_agent: z.string().optional().describe("User-agent string to match against groups (default '*')"),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      max_redirects: z.number().int().min(0).max(20).optional(),
      allow_private_hosts: z.boolean().optional(),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ url, user_agent, timeout_ms, max_redirects, allow_private_hosts }) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return formatError("URL failed to parse");
      }
      const robotsUrl = `${parsed.origin}/robots.txt`;
      const res = await httpRequest({
        method: "GET",
        url: robotsUrl,
        timeoutMs: timeout_ms,
        maxBytes: 512 * 1024,
        maxRedirects: max_redirects,
        allowPrivateHosts: allow_private_hosts,
        decodeText: true,
      });
      // 404 means "no rules -- everything allowed" per the spec
      if (res.error) return formatError(res.error);
      if (res.status === 404) {
        return formatJson({
          robotsUrl,
          status: 404,
          allowed: true,
          note: "no robots.txt -- crawl permitted by default",
        });
      }
      if (!res.ok) return formatError(`HTTP ${res.status} ${res.statusText} fetching ${robotsUrl}`);
      const robots = parseRobots(res.bodyText ?? "");
      const ua = user_agent ?? "*";
      const verdict = isAllowed(robots, ua, parsed.pathname + parsed.search);
      return formatJson({
        robotsUrl,
        status: res.status,
        userAgent: ua,
        path: parsed.pathname + parsed.search,
        allowed: verdict.allowed,
        matchedRule: verdict.rule ?? null,
        crawlDelay: pickGroup(robots, ua)?.crawlDelay ?? null,
        sitemaps: robots.sitemaps,
        rawRobotsText: res.bodyText,
      });
    },
  );
}
