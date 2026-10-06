import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// scripts/update-manifests.mjs writes package.json's description into a Ruby
// double-quoted string in the Homebrew formula. These tests pin the escaping
// that keeps that value a plain string (CodeQL js/incomplete-sanitization).
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "update-manifests.mjs");

interface FormulaInput {
  className: string;
  cmd: string;
  description: unknown;
  homepage: string;
  version: string;
  license: string | undefined;
  assets: Record<"macArm64" | "macX64" | "linuxX64", { url: string; sha256: string }>;
}

let rubyString: (value: unknown) => string;
let renderFormula: (input: FormulaInput) => string;

beforeAll(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs.
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    rubyString: typeof rubyString;
    renderFormula: typeof renderFormula;
  };
  rubyString = mod.rubyString;
  renderFormula = mod.renderFormula;
});

// Read the body of a Ruby double-quoted literal the way Ruby does, failing on
// anything that would end the string early or interpolate code.
function parseRubyDq(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[++i];
      if (next === undefined) throw new Error("dangling backslash escapes the closing quote");
      out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    } else if (c === '"') {
      throw new Error(`unescaped quote at ${i} ends the string early`);
    } else if (c === "#" && /[{@$]/.test(body[i + 1] ?? "")) {
      throw new Error(`unescaped interpolation at ${i}`);
    } else if (c === "\n" || c === "\r") {
      throw new Error(`raw line break at ${i}`);
    } else {
      out += c;
    }
  }
  return out;
}

const HOSTILE = 'evil \\" #{system("touch /tmp/pwned")} #@iv #$gv\nline two';

function formulaInput(description: unknown): FormulaInput {
  const asset = (name: string) => ({
    url: `https://github.com/YawLabs/fetch-mcp/releases/download/v1.2.3/${name}`,
    sha256: "a".repeat(64),
  });
  return {
    className: "FetchMcp",
    cmd: "fetch-mcp",
    description,
    homepage: "https://yaw.sh/mcp-servers/fetch-mcp/",
    version: "1.2.3",
    license: "MIT",
    assets: {
      macArm64: asset("fetch-mcp-darwin-arm64"),
      macX64: asset("fetch-mcp-darwin-x64"),
      linuxX64: asset("fetch-mcp-linux-x64"),
    },
  };
}

describe("update-manifests rubyString", () => {
  const cases = [
    "Fetch MCP server for AI agents: HTTP requests, HTML-to-markdown, reader mode, metadata, links, sitemaps, RSS/Atom, robots.txt, SSRF-safe",
    'He said "hi"',
    "trailing backslash \\",
    'backslash then quote \\"',
    "C:\\path\\to\\thing",
    '#{system("rm -rf ~")}',
    "#@ivar and #$global",
    "\\#{already escaped?}",
    "line one\nline two\r\n",
    "C# support, issue #12",
    "",
  ];

  for (const input of cases) {
    it(`round-trips ${JSON.stringify(input)}`, () => {
      expect(parseRubyDq(rubyString(input))).toBe(input);
    });
  }

  it("escapes the backslash before the quote", () => {
    // The old `.replace(/"/g, '\\"')` turned `\"` into `\\"`, which Ruby reads
    // as an escaped backslash followed by a closing quote.
    expect(rubyString('a\\"b')).toBe('a\\\\\\"b');
  });

  it("escapes # only where it starts interpolation", () => {
    // brew style flags `\#` before anything else as a redundant escape.
    expect(rubyString("C# support, issue #12")).toBe("C# support, issue #12");
    expect(rubyString("#{x} #@y #$z")).toBe("\\#{x} \\#@y \\#$z");
  });

  it("treats null and undefined as empty", () => {
    expect(rubyString(undefined)).toBe("");
    expect(rubyString(null)).toBe("");
  });
});

describe("update-manifests renderFormula", () => {
  it("sends the description through rubyString", () => {
    const formula = renderFormula(formulaInput(HOSTILE));
    const descLines = formula.split("\n").filter((l) => l.startsWith("  desc "));
    expect(descLines).toHaveLength(1);
    const m = /^ {2}desc "(.*)"$/.exec(descLines[0]);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(rubyString(HOSTILE));
    expect(parseRubyDq(m?.[1] ?? "")).toBe(HOSTILE);
  });

  it("keeps every other string stanza a plain literal", () => {
    const formula = renderFormula({ ...formulaInput("ok"), homepage: 'https://x/"#{1}', license: 'MIT"#{2}' });
    const strings = [...formula.matchAll(/^ {2}(?:homepage|version|license) "(.*)"$/gm)].map((m) => m[1]);
    expect(strings).toHaveLength(3);
    expect(strings.map(parseRubyDq)).toEqual(['https://x/"#{1}', "1.2.3", 'MIT"#{2}']);
  });

  it("writes license :cannot_represent for an unlicensed package", () => {
    expect(renderFormula({ ...formulaInput("ok"), license: "UNLICENSED" })).toContain("  license :cannot_represent\n");
    expect(renderFormula({ ...formulaInput("ok"), license: undefined })).toContain("  license :cannot_represent\n");
  });

  it("refuses a class name that is not a Ruby constant", () => {
    expect(() => renderFormula({ ...formulaInput("ok"), className: "Fetch; system('x')" })).toThrow(/class name/);
  });
});
