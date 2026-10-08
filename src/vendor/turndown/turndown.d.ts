/**
 * Types for the vendored, patched Turndown in ./turndown.js. Adapted from
 * @types/turndown 5.0 (MIT), with DOM types replaced by the minimal domino
 * shapes (tsconfig has no DOM lib) and the patch surface added: node-only
 * input, `deadline` / `visited`, `maxOutput` / `maxWork` / `work`, `chunkSize`,
 * `Rule.ignoresContent`, ConversionDeadlineError and ConversionLimitError.
 */
import type { DomElement, DomNode } from "@mixmark-io/domino";

declare class TurndownService {
  constructor(options?: TurndownService.Options);

  addRule(key: string, rule: TurndownService.Rule): this;
  keep(filter: TurndownService.Filter): this;
  remove(filter: TurndownService.Filter): this;
  use(plugins: TurndownService.Plugin | TurndownService.Plugin[]): this;
  escape(str: string): string;

  /** PATCH (a): a node only, converted in place (it is mutated, never cloned). */
  turndown(node: DomNode): string;

  options: TurndownService.Options;
  rules: TurndownService.Rules;

  /** PATCH (e): performance.now() value after which process() throws ConversionDeadlineError. */
  deadline?: number;
  /** PATCH (e): nodes visited so far; reset it to 0 with each new deadline. */
  visited: number;
  /** PATCH (g): cap, in characters, on the output collected for any one parent; past it, ConversionLimitError. */
  maxOutput?: number;
  /** PATCH (g): cap, in characters, on the replacement work charged in all; past it, ConversionLimitError (kind "work"). */
  maxWork?: number;
  /** PATCH (g): characters of replacement work charged by the last turndown() call. */
  readonly work: number;
  /**
   * PATCH (j): longest string one operation works on between deadline checks
   * (default 65,536). Only tests lower it, to run the chunked paths on small input.
   */
  chunkSize?: number;
}

declare namespace TurndownService {
  interface Options {
    headingStyle?: "setext" | "atx" | undefined;
    hr?: string | undefined;
    br?: string | undefined;
    bulletListMarker?: "-" | "+" | "*" | undefined;
    codeBlockStyle?: "indented" | "fenced" | undefined;
    emDelimiter?: "_" | "*" | undefined;
    fence?: "```" | "~~~" | undefined;
    strongDelimiter?: "__" | "**" | undefined;
    linkStyle?: "inlined" | "referenced" | undefined;
    linkReferenceStyle?: "full" | "collapsed" | "shortcut" | undefined;
    preformattedCode?: boolean;

    keepReplacement?: ReplacementFunction | undefined;
    blankReplacement?: ReplacementFunction | undefined;
    defaultReplacement?: ReplacementFunction | undefined;
  }

  interface Rule {
    filter: Filter;
    replacement?: ReplacementFunction | undefined;
    /**
     * PATCH (k): the replacement never reads `content`, so the element's
     * subtree is not converted at all and the replacement gets ''.
     */
    ignoresContent?: boolean | undefined;
  }

  interface Rules {
    options: Options;
    array: Rule[];

    blankRule: ReplacementFunction;
    defaultRule: ReplacementFunction;
    keepReplacement: ReplacementFunction;

    add(key: Filter, rule: Rule): void;
    forEach(callback: (rule: Rule, index: number) => any): void;
    forNode(node: DomElement): Rule;
    keep(filter: Filter): void;
    remove(filter: Filter): void;
  }

  type Plugin = (service: TurndownService) => void;

  type Filter = TagName | TagName[] | FilterFunction;
  type FilterFunction = (node: DomElement, options: Options) => boolean;

  type ReplacementFunction = (content: string, node: DomElement, options: Options) => string;

  type TagName = string;
}

export default TurndownService;

/** PATCH (e): thrown once `deadline` has passed. */
export declare class ConversionDeadlineError extends Error {}

/** PATCH (g): thrown once the output collected for one parent passes `maxOutput`, or the work charged passes `maxWork`. */
export declare class ConversionLimitError extends Error {
  readonly limit: number;
  readonly kind: "output" | "work";
}
