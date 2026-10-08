/**
 * Types for the parts of @mixmark-io/domino (Turndown's own HTML parser) that
 * src/markdown.ts uses. The package's bundled index.d.ts declares a module
 * named "domino" and leaves out the incremental parser, and tsconfig's `lib`
 * has no DOM, so the node shapes are declared here, minimally.
 *
 * `_nextnid` is private to domino: every node the document creates takes the
 * next id, so it is a deterministic count of nodes built so far. The package
 * is pinned exactly in package.json for that reason, and
 * src/tests/markdown.test.ts fails if a release stops advancing it.
 */
declare module "@mixmark-io/domino" {
  export interface DomNode {
    readonly nodeType: number;
    readonly nodeName: string;
    readonly parentNode: DomNode | null;
    readonly firstChild: DomNode | null;
    readonly nextSibling: DomNode | null;
    readonly childNodes: ArrayLike<DomNode>;
    textContent: string | null;
  }

  export interface DomElement extends DomNode {
    /**
     * A plain property set at creation. Read this, not tagName/nodeName, to
     * look at a name without filling domino's module-level uppercase cache.
     */
    readonly localName: string;
    readonly prefix: string | null;
    readonly tagName: string;
    readonly firstElementChild: DomElement | null;
    readonly nextElementSibling: DomElement | null;
    readonly outerHTML: string;
    getAttribute(name: string): string | null;
  }

  export interface DominoDocument extends DomNode {
    getElementById(id: string): DomElement | null;
    /** Private: the id the next created node gets, i.e. nodes created so far + 1. */
    readonly _nextnid: number;
  }

  export interface IncrementalHTMLParser {
    /** Queue the last (here: only) chunk of input. Parses nothing yet. */
    end(html?: string): void;
    /** Parse until `pause()` returns true at a token boundary; true while work remains. */
    process(pause: () => boolean): boolean;
    document(): DominoDocument;
  }

  interface Domino {
    createIncrementalHTMLParser(): IncrementalHTMLParser;
    createDocument(html?: string, force?: boolean): DominoDocument;
  }

  const domino: Domino;
  export default domino;
}
