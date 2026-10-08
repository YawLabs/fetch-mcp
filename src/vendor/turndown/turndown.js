/*!
 * Vendored from turndown 7.2.4 (https://github.com/mixmark-io/turndown),
 * lib/turndown.es.js, under its MIT license (also in ./LICENSE). This comment
 * is a legal comment (/*!) so bundlers keep the notice in dist.
 *
 * MIT License
 *
 * Copyright (c) 2017 Dom Christie
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Do not import the npm `turndown` package anywhere in src/: this copy is the
 * only Turndown fetch-mcp runs, and only src/markdown.ts may use it.
 *
 * PATCHES (each marked "PATCH (x)" at its site):
 *   (a) RootNode / canConvert / turndown(): accept a DOM node only and convert
 *       it in place -- no clone, no string input, and the upstream parser
 *       fallback (a CommonJS require of its DOM library) is gone: it would
 *       break inside tsup's ESM bundle, and src/markdown.ts parses the page
 *       itself in bounded slices.
 *   (b) process(): children are joined through a parts array plus a trailing
 *       newline count, in place of reduce(join), which was quadratic in the
 *       number of children. Output is identical.
 *   (c) postProcess(): trailing whitespace is trimmed with a loop in place of
 *       the quadratic regex /[\t\r\n\s]+$/ (same character set).
 *   (d) hasVoid() / hasMeaningfulWhenBlank(): read the flags (f) precomputes,
 *       in place of a getElementsByTagName() scan per tag name.
 *   (e) When the instance has a numeric `deadline` (performance.now() based),
 *       EVERY node visit -- in collapseWhitespace(), the (f) pre-pass and
 *       process() -- checks it and throws ConversionDeadlineError once it has
 *       passed, and so does (g) as replacement work accumulates. `visited`
 *       counts process()'s node visits.
 *   (f) precomputeFacts(): ONE iterative post-order pass over the root, after
 *       collapseWhitespace() and before process(), records per text node and
 *       element what upstream re-derived from textContent or a subtree walk at
 *       every node (O(depth x nodes) in all): whether its text is
 *       whitespace-only, the text's leading/trailing whitespace runs and their
 *       ASCII parts (the split edgeWhitespace()'s regex makes), its first and
 *       last character and length, whether a void or meaningful-when-blank
 *       element is below it, and an <ol> item's index. isBlank(),
 *       flankingWhitespace(), isFlankedByWhitespace() and the listItem rule
 *       read these, so each node costs O(1) amortized. Output is identical;
 *       nothing mutates the DOM after the pass.
 *   (g) Replacement work is counted, in characters, BEFORE it runs: text
 *       escaped, content trimmed or rewritten by a rule (blockquote and
 *       listItem rewrite every line of their content at each nesting level),
 *       children joined, a code block's text. Every 64 Ki characters re-check
 *       the deadline, so one node's work cannot outrun it by much. And when
 *       the instance has a numeric `maxOutput`, process() throws
 *       ConversionLimitError as soon as the output it is collecting for one
 *       parent passes it, before joining it: nesting cannot amplify a page
 *       into an O(depth x content) string. `work` is the counter; when
 *       the instance has a numeric `maxWork`, charge() throws
 *       ConversionLimitError (kind 'work') as soon as `work` passes it, before
 *       the work runs: nested blockquotes or list items around flat text
 *       re-prefix every line at each level without growing any one parent's
 *       output past `maxOutput`.
 *   (h) RootNode(): collapseWhitespace() runs with the document's private
 *       `modclock` at 0, so domino's modify() does not walk every ancestor
 *       on each node it removes (O(depth) per removal); restored afterwards.
 *   (i) The inline code rule: upstream's extraSpace test
 *       /^`|^ .*?[^ ].* $|`$/ backtracks quadratically on content that starts
 *       with a space and does not end with one (100 KB took 17 s), and its
 *       delimiter loop re-scanned every backtick run once per delimiter length
 *       tried. needsCodeSpace() is the same test in one pass, and
 *       codeDelimiter() collects the run lengths into a Set once and picks
 *       the shortest absent length. Output is identical.
 *   (j) No single string operation runs on more than CHUNK (64 Ki)
 *       characters between two deadline checks, whatever the size of one
 *       text node, attribute or rule's content: the escapes (text, image
 *       alt, link href/src and title), cleanAttribute(), collapseWhitespace()'s
 *       run collapse, and the blockquote, listItem and inline-code rewrites
 *       run chunk by chunk through boundedReplace(), each chunk charged (g)
 *       first. A chunk only ends where no match of its regex can straddle
 *       the cut; strings up to CHUNK run upstream's expression unchanged.
 *       escapeMarkdown() applies the global escapes per chunk and the
 *       ^-anchored ones to the head (they only ever touch it). Each chunk's
 *       result is flattened at once: V8 returns a global replace as a rope of
 *       one node per match, which held until the join multiplied the heap
 *       about 30x and with it the GC pauses. The loops that scan a run
 *       (leading/trailing newlines and whitespace, trim(), the fence size and
 *       backtick runs) check the deadline every CHUNK characters, the regex
 *       tests on one character or one end became character-code checks, and
 *       isWsAt() matches \s without a regex. The deadline is also checked
 *       after each chunked join and before process() reads a long rule
 *       result, so a whole-string copy runs between two checks on its own.
 *       An <ol>'s `start` is converted once per list, not once per item.
 *       Output is identical.
 *   (k) Nothing is converted only to be discarded, and no level of nesting
 *       keeps its own copy of the text. replacementForNode() hands a rule
 *       marked `ignoresContent` (the blank rule and keep() with their default
 *       replacements, remove(), and fetch-mcp's own removal rules) '' without
 *       process()ing the subtree or trimming the result: upstream converted
 *       every blank or removed subtree and threw the result away, which with
 *       whitespace-only elements nested 250 deep was O(depth x text) (2.5 MB
 *       took 9.7 s). And an element's whitespace runs from (f) are ropes
 *       shared with every ancestor's, which V8 flattens IN PLACE on the first
 *       substring() or character read: flankingWhitespace() now takes the
 *       runs without their ASCII edge from precomputed ropes (_tdLeadRest,
 *       _tdTrailRest) instead of substring(), and emitReplacement() hands
 *       process() a fresh copy when a replacement would be a cached run
 *       itself. Before, each level kept one flat copy of the text below it
 *       (~100 bytes of heap per input character at 100 deep; 20 MB OOM-killed
 *       a 4 GB heap). Never call substring(), charCodeAt() or a regex on a
 *       cached _td* run. Output is identical.
 */

function extend(destination) {
  for (var i = 1; i < arguments.length; i++) {
    var source = arguments[i];
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) destination[key] = source[key];
    }
  }
  return destination;
}
function repeat(character, count) {
  return Array(count + 1).join(character);
}
function trimLeadingNewlines(string) {
  // PATCH (j): string.replace(/^\n*/, ''), as a checked scan.
  return string.substring(scanWhile(string, 0, isNewlineAt));
}
function trimTrailingNewlines(string) {
  // avoid match-at-end regexp bottleneck, see #370
  var indexEnd = string.length;
  while (indexEnd > 0 && string.charCodeAt(indexEnd - 1) === 10) {
    indexEnd--;
    if ((indexEnd & CHUNK_MASK) === 0) checkDeadline(bound); // PATCH (j)
  }
  return string.substring(0, indexEnd);
}
function isNewlineAt(s, i) {
  return s.charCodeAt(i) === 10;
}
function trimNewlines(string) {
  return trimTrailingNewlines(trimLeadingNewlines(string));
}
var blockElements = ['ADDRESS', 'ARTICLE', 'ASIDE', 'AUDIO', 'BLOCKQUOTE', 'BODY', 'CANVAS', 'CENTER', 'DD', 'DIR', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'FRAMESET', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'HTML', 'ISINDEX', 'LI', 'MAIN', 'MENU', 'NAV', 'NOFRAMES', 'NOSCRIPT', 'OL', 'OUTPUT', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'];
function isBlock(node) {
  return is(node, blockElements);
}
var voidElements = ['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR'];
function isVoid(node) {
  return is(node, voidElements);
}
// PATCH (d): flag precomputed by (f).
function hasVoid(node) {
  return node._tdHasVoid === true;
}
var meaningfulWhenBlankElements = ['A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TH', 'TD', 'IFRAME', 'SCRIPT', 'AUDIO', 'VIDEO'];
function isMeaningfulWhenBlank(node) {
  return is(node, meaningfulWhenBlankElements);
}
// PATCH (d): flag precomputed by (f).
function hasMeaningfulWhenBlank(node) {
  return node._tdHasMwb === true;
}
function is(node, tagNames) {
  return tagNames.indexOf(node.nodeName) >= 0;
}
var markdownEscapes = [[/\\/g, '\\\\'], [/\*/g, '\\*'], [/^-/g, '\\-'], [/^\+ /g, '\\+ '], [/^(=+)/g, '\\$1'], [/^(#{1,6}) /g, '\\$1 '], [/`/g, '\\`'], [/^~~~/g, '\\~~~'], [/\[/g, '\\['], [/\]/g, '\\]'], [/^>/g, '\\>'], [/_/g, '\\_'], [/^(\d+)\. /g, '$1\\. ']];
function escapeMarkdownWhole(string) {
  return markdownEscapes.reduce(function (accumulator, escape) {
    return accumulator.replace(escape[0], escape[1]);
  }, string);
}
// PATCH (j): escapeMarkdownWhole() on a long string, CHUNK at a time. The
// global escapes are single characters, so they apply per chunk; each anchored
// one (^ without the m flag) only inserts a backslash at the start, or before
// the "." of a leading "123. ", and none of their characters is one the global
// escapes touch, so applying them after the global ones changes nothing.
var globalEscapes = markdownEscapes.filter(function (e) {
  return e[0].source.charAt(0) !== '^';
});
var anchoredEscapes = markdownEscapes.filter(function (e) {
  return e[0].source.charAt(0) === '^';
});
function escapeMarkdown(string) {
  if (!bound || string.length <= bound.chunkSize) return escapeMarkdownWhole(string);
  var escaped = boundedMap(string, function (chunk) {
    for (var i = 0; i < globalEscapes.length; i++) chunk = chunk.replace(globalEscapes[i][0], globalEscapes[i][1]);
    return chunk;
  }, null);
  var c = escaped.charCodeAt(0);
  if (c >= 48 && c <= 57) {
    // Only /^(\d+)\. / can match a string that starts with a digit.
    var d = scanWhile(escaped, 0, isDigitAt);
    if (escaped.charCodeAt(d) === 46 && escaped.charCodeAt(d + 1) === 32) {
      return escaped.substring(0, d) + '\\' + escaped.substring(d);
    }
    return escaped;
  }
  // The rest match within 7 characters; /^(=+)/ prepends one backslash
  // however long its run, so cutting the run changes nothing.
  var head = escaped.substring(0, 8);
  for (var i = 0; i < anchoredEscapes.length; i++) head = head.replace(anchoredEscapes[i][0], anchoredEscapes[i][1]);
  return head + escaped.substring(8);
}

var rules = {};
rules.paragraph = {
  filter: 'p',
  replacement: function (content) {
    return '\n\n' + content + '\n\n';
  }
};
rules.lineBreak = {
  filter: 'br',
  replacement: function (content, node, options) {
    return options.br + '\n';
  }
};
rules.heading = {
  filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  replacement: function (content, node, options) {
    var hLevel = Number(node.nodeName.charAt(1));
    if (options.headingStyle === 'setext' && hLevel < 3) {
      var underline = repeat(hLevel === 1 ? '=' : '-', content.length);
      return '\n\n' + content + '\n' + underline + '\n\n';
    } else {
      return '\n\n' + repeat('#', hLevel) + ' ' + content + '\n\n';
    }
  }
};
rules.blockquote = {
  filter: 'blockquote',
  replacement: function (content) {
    content = trimNewlines(content);
    // PATCH (j): /^/gm matches at the start and after every line terminator.
    content = !bound || content.length <= bound.chunkSize ? content.replace(/^/gm, '> ') : '> ' + boundedReplace(content, /[\n\r\u2028\u2029]/g, '$&> ', null);
    return '\n\n' + content + '\n\n';
  }
};
rules.list = {
  filter: ['ul', 'ol'],
  replacement: function (content, node) {
    var parent = node.parentNode;
    if (parent.nodeName === 'LI' && parent.lastElementChild === node) {
      return '\n' + content;
    } else {
      return '\n\n' + content + '\n\n';
    }
  }
};
rules.listItem = {
  filter: 'li',
  replacement: function (content, node, options) {
    var prefix = options.bulletListMarker + '   ';
    var parent = node.parentNode;
    if (parent.nodeName === 'OL') {
      var start = parent.getAttribute('start');
      // PATCH (f): precomputed; indexOf over parent.children per item was quadratic.
      var index = node._tdIndex;
      // PATCH (j): Number(start) once per list, not once per item.
      if (parent._tdStart !== start) {
        parent._tdStart = start;
        parent._tdStartNum = Number(start);
      }
      prefix = (start ? parent._tdStartNum + index : index + 1) + '.  ';
    }
    // PATCH (j): /\n$/ (no m flag) is "ends with \n"; the indent is chunked.
    var isParagraph = content.charCodeAt(content.length - 1) === 10;
    content = trimNewlines(content) + (isParagraph ? '\n' : '');
    content = boundedReplace(content, /\n/gm, '\n' + ' '.repeat(prefix.length), null); // indent
    return prefix + content + (node.nextSibling ? '\n' : '');
  }
};
rules.indentedCodeBlock = {
  filter: function (node, options) {
    return options.codeBlockStyle === 'indented' && node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE';
  },
  replacement: function (content, node, options) {
    return '\n\n    ' + node.firstChild.textContent.replace(/\n/g, '\n    ') + '\n\n';
  }
};
rules.fencedCodeBlock = {
  filter: function (node, options) {
    return options.codeBlockStyle === 'fenced' && node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE';
  },
  replacement: function (content, node, options) {
    var className = node.firstChild.getAttribute('class') || '';
    var language = (className.match(/language-(\S+)/) || [null, ''])[1];
    var code = node.firstChild.textContent;
    var fenceChar = options.fence.charAt(0);
    var fenceSize = 3;
    var fenceInCodeRegex = new RegExp('^' + fenceChar + '{3,}', 'gm');
    var match;
    if (bound && code.length > bound.chunkSize) {
      // PATCH (j): the same fence size in one checked pass.
      fenceSize = longestLineStartRun(code, fenceChar.charCodeAt(0), fenceSize);
    } else {
      while (match = fenceInCodeRegex.exec(code)) {
        if (match[0].length >= fenceSize) {
          fenceSize = match[0].length + 1;
        }
      }
    }
    var fence = repeat(fenceChar, fenceSize);
    // PATCH (j): /\n$/ (no m flag) is "ends with \n".
    var body = code.charCodeAt(code.length - 1) === 10 ? code.substring(0, code.length - 1) : code;
    return '\n\n' + fence + language + '\n' + body + '\n' + fence + '\n\n';
  }
};
rules.horizontalRule = {
  filter: 'hr',
  replacement: function (content, node, options) {
    return '\n\n' + options.hr + '\n\n';
  }
};
rules.inlineLink = {
  filter: function (node, options) {
    return options.linkStyle === 'inlined' && node.nodeName === 'A' && node.getAttribute('href');
  },
  replacement: function (content, node) {
    var href = escapeLinkDestination(node.getAttribute('href'));
    var title = escapeLinkTitle(cleanAttribute(node.getAttribute('title')));
    var titlePart = title ? ' "' + title + '"' : '';
    return '[' + content + '](' + href + titlePart + ')';
  }
};
rules.referenceLink = {
  filter: function (node, options) {
    return options.linkStyle === 'referenced' && node.nodeName === 'A' && node.getAttribute('href');
  },
  replacement: function (content, node, options) {
    var href = escapeLinkDestination(node.getAttribute('href'));
    var title = cleanAttribute(node.getAttribute('title'));
    if (title) title = ' "' + escapeLinkTitle(title) + '"';
    var replacement;
    var reference;
    switch (options.linkReferenceStyle) {
      case 'collapsed':
        replacement = '[' + content + '][]';
        reference = '[' + content + ']: ' + href + title;
        break;
      case 'shortcut':
        replacement = '[' + content + ']';
        reference = '[' + content + ']: ' + href + title;
        break;
      default:
        var id = this.references.length + 1;
        replacement = '[' + content + '][' + id + ']';
        reference = '[' + id + ']: ' + href + title;
    }
    this.references.push(reference);
    return replacement;
  },
  references: [],
  append: function (options) {
    var references = '';
    if (this.references.length) {
      references = '\n\n' + this.references.join('\n') + '\n\n';
      this.references = []; // Reset references
    }
    return references;
  }
};
rules.emphasis = {
  filter: ['em', 'i'],
  replacement: function (content, node, options) {
    if (!trimWs(content)) return ''; // PATCH (j)
    return options.emDelimiter + content + options.emDelimiter;
  }
};
rules.strong = {
  filter: ['strong', 'b'],
  replacement: function (content, node, options) {
    if (!trimWs(content)) return ''; // PATCH (j)
    return options.strongDelimiter + content + options.strongDelimiter;
  }
};
rules.code = {
  filter: function (node) {
    var hasSiblings = node.previousSibling || node.nextSibling;
    var isCodeBlock = node.parentNode.nodeName === 'PRE' && !hasSiblings;
    return node.nodeName === 'CODE' && !isCodeBlock;
  },
  replacement: function (content) {
    if (!content) return '';
    content = boundedReplace(content, /\r?\n|\r/g, ' ', crlfBoundary); // PATCH (j)
    // PATCH (i): linear equivalents of upstream's regex test and delimiter loop.
    var extraSpace = needsCodeSpace(content) ? ' ' : '';
    var delimiter = codeDelimiter(content);
    return delimiter + extraSpace + content + extraSpace + delimiter;
  }
};
rules.image = {
  filter: 'img',
  replacement: function (content, node) {
    var alt = escapeMarkdown(cleanAttribute(node.getAttribute('alt')));
    var src = escapeLinkDestination(node.getAttribute('src') || '');
    var title = cleanAttribute(node.getAttribute('title'));
    var titlePart = title ? ' "' + escapeLinkTitle(title) + '"' : '';
    return src ? '![' + alt + ']' + '(' + src + titlePart + ')' : '';
  }
};
// PATCH (j): chunked; a match never spans a non-whitespace character.
function cleanAttribute(attribute) {
  return attribute ? boundedReplace(attribute, /(\n+\s*)+/g, '\n', afterNonWs) : '';
}
function escapeLinkDestination(destination) {
  var escaped = boundedReplace(destination, /([<>()])/g, '\\$1', null); // PATCH (j)
  return escaped.indexOf(' ') >= 0 ? '<' + escaped + '>' : escaped;
}
function escapeLinkTitle(title) {
  return boundedReplace(title, /"/g, '\\"', null); // PATCH (j)
}

// PATCH (i): /^`|^ .*?[^ ].* $|`$/.test(s) in one pass. The middle branch
// wants a space at each end and, between them, one non-space character with
// no line terminator (which `.` does not match) on either side of it: so at
// most one line terminator (it is then that character), and if there is none,
// some character that is not a space.
function needsCodeSpace(s) {
  var n = s.length;
  if (n === 0) return false;
  if (s.charCodeAt(0) === 96 || s.charCodeAt(n - 1) === 96) return true;
  if (n < 3 || s.charCodeAt(0) !== 32 || s.charCodeAt(n - 1) !== 32) return false;
  var terminators = 0;
  var nonSpace = false;
  for (var i = 1; i < n - 1; i++) {
    var c = s.charCodeAt(i);
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) {
      if (++terminators > 1) return false;
      nonSpace = true;
    } else if (c !== 32) {
      nonSpace = true;
    }
  }
  return nonSpace;
}
// PATCH (i): upstream grew the delimiter one backtick at a time while
// content.match(/`+/gm) held a run of exactly that length: the result is the
// shortest run length (from 1) that does not occur.
function codeDelimiter(s) {
  var lengths = new Set();
  var n = s.length;
  for (var i = 0; i < n; i++) {
    if ((i & CHUNK_MASK) === CHUNK_MASK) checkDeadline(bound);
    if (s.charCodeAt(i) !== 96) continue;
    var end = scanWhile(s, i, isBacktickAt);
    lengths.add(end - i);
    i = end;
  }
  var size = 1;
  while (lengths.has(size)) size++;
  return repeat('`', size);
}
// PATCH (j): the fence size upstream's /^X{3,}/gm exec loop computes: one
// more than the longest run of the fence character at a line start (^ with the
// m flag: the start, or after \n \r U+2028 U+2029), if any run is 3 or longer.
function longestLineStartRun(s, code, fenceSize) {
  var n = s.length;
  var lineStart = true;
  for (var i = 0; i < n; i++) {
    if ((i & CHUNK_MASK) === CHUNK_MASK) checkDeadline(bound);
    var c = s.charCodeAt(i);
    if (lineStart && c === code) {
      var j = scanWhile(s, i, function (t, k) {
        return t.charCodeAt(k) === code;
      });
      if (j - i >= 3 && j - i >= fenceSize) fenceSize = j - i + 1;
      i = j - 1;
      lineStart = false;
      continue;
    }
    lineStart = c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
  }
  return fenceSize;
}

// PATCH (j): the service converting right now (set by turndown()), so the
// helpers above can charge their work and check its deadline. Outside a
// conversion they run upstream's expressions unchanged.
var bound = null;
var CHUNK = 65536;
var CHUNK_MASK = CHUNK - 1;
function isDigitAt(s, i) {
  var c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
}
function isBacktickAt(s, i) {
  return s.charCodeAt(i) === 96;
}
function isAsciiWsAt(s, i) {
  var c = s.charCodeAt(i);
  return c === 32 || c === 13 || c === 10 || c === 9;
}
// First index >= i where pred fails (or s.length), checking the deadline
// every CHUNK characters.
function scanWhile(s, i, pred) {
  var n = s.length;
  while (i < n && pred(s, i)) {
    i++;
    if ((i & CHUNK_MASK) === 0) checkDeadline(bound);
  }
  return i;
}
// Chunk boundaries: k is a valid cut when no match can contain both s[k-1]
// and s[k].
function crlfBoundary(s, k) {
  return s.charCodeAt(k - 1) === 13 && s.charCodeAt(k) === 10 ? k + 1 : k;
}
function afterNonWs(s, k) {
  // A cut after a whitespace character could split a run.
  return isWsAt(s, k - 1) ? scanWhile(s, k, isWsAt) : k;
}
function inAsciiWsRun(s, k) {
  return isAsciiWsAt(s, k - 1) && isAsciiWsAt(s, k) ? scanWhile(s, k, isAsciiWsAt) : k;
}
// fn over CHUNK-sized slices (cut where `boundary` allows), each charged first
// and flattened.
function boundedMap(string, fn, boundary) {
  var n = string.length;
  var size = bound.chunkSize;
  var parts = [];
  var start = 0;
  while (start < n) {
    var end = start + size;
    if (end >= n) end = n;
    else if (boundary) end = boundary(string, end);
    charge(bound, end - start);
    var piece = fn(string.substring(start, end));
    // V8 returns a global replace's result as a rope, one node per match
    // (~30 bytes per character), and parts.join() only flattens it at the
    // end: held until then, the ropes multiply the heap and GC pauses.
    // charCodeAt() flattens a rope in place.
    piece.charCodeAt(0);
    parts.push(piece);
    start = end;
  }
  var joined = parts.join('');
  checkDeadline(bound); // the join copies the whole string
  return joined;
}
// string.replace(regex, replacement), CHUNK at a time during a conversion.
function boundedReplace(string, regex, replacement, boundary) {
  if (!bound || string.length <= bound.chunkSize) return string.replace(regex, replacement);
  return boundedMap(string, function (chunk) {
    return chunk.replace(regex, replacement);
  }, boundary);
}

/**
 * Manages a collection of rules used to convert HTML to Markdown
 */

function Rules(options) {
  this.options = options;
  this._keep = [];
  this._remove = [];
  this.blankRule = {
    replacement: options.blankReplacement,
    // PATCH (k): the default blankReplacement ignores its content.
    ignoresContent: options.blankReplacement === defaultBlankReplacement
  };
  this.keepReplacement = options.keepReplacement;
  this.defaultRule = {
    replacement: options.defaultReplacement
  };
  this.array = [];
  for (var key in options.rules) this.array.push(options.rules[key]);
}
Rules.prototype = {
  add: function (key, rule) {
    this.array.unshift(rule);
  },
  keep: function (filter) {
    this._keep.unshift({
      filter: filter,
      replacement: this.keepReplacement,
      // PATCH (k): the default keepReplacement reads outerHTML, not content.
      ignoresContent: this.keepReplacement === defaultKeepReplacement
    });
  },
  remove: function (filter) {
    this._remove.unshift({
      filter: filter,
      replacement: function () {
        return '';
      },
      ignoresContent: true // PATCH (k)
    });
  },
  forNode: function (node) {
    if (node.isBlank) return this.blankRule;
    var rule;
    if (rule = findRule(this.array, node, this.options)) return rule;
    if (rule = findRule(this._keep, node, this.options)) return rule;
    if (rule = findRule(this._remove, node, this.options)) return rule;
    return this.defaultRule;
  },
  forEach: function (fn) {
    for (var i = 0; i < this.array.length; i++) fn(this.array[i], i);
  }
};
function findRule(rules, node, options) {
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    if (filterValue(rule, node, options)) return rule;
  }
  return undefined;
}
function filterValue(rule, node, options) {
  var filter = rule.filter;
  if (typeof filter === 'string') {
    if (filter === node.nodeName.toLowerCase()) return true;
  } else if (Array.isArray(filter)) {
    if (filter.indexOf(node.nodeName.toLowerCase()) > -1) return true;
  } else if (typeof filter === 'function') {
    if (filter.call(rule, node, options)) return true;
  } else {
    throw new TypeError('`filter` needs to be a string, array, or function');
  }
}

/**
 * The collapseWhitespace function is adapted from collapse-whitespace
 * by Luc Thevenard.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Luc Thevenard <lucthevenard@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/**
 * collapseWhitespace(options) removes extraneous whitespace from an the given element.
 *
 * @param {Object} options
 */
function collapseWhitespace(options) {
  var element = options.element;
  var isBlock = options.isBlock;
  var isVoid = options.isVoid;
  var isPre = options.isPre || function (node) {
    return node.nodeName === 'PRE';
  };
  var service = options.service; // PATCH (e)
  if (!element.firstChild || isPre(element)) return;
  var prevText = null;
  var keepLeadingWs = false;
  var prev = null;
  var node = next(prev, element, isPre);
  while (node !== element) {
    checkDeadline(service); // PATCH (e)
    if (node.nodeType === 3 || node.nodeType === 4) {
      // Node.TEXT_NODE or Node.CDATA_SECTION_NODE
      var text = boundedReplace(node.data, /[ \r\n\t]+/g, ' ', inAsciiWsRun); // PATCH (j)
      // PATCH (j): / $/ is "ends with a space".
      if ((!prevText || endsWithSpace(prevText.data)) && !keepLeadingWs && text[0] === ' ') {
        text = text.substr(1);
      }

      // `text` might be empty at this point.
      if (!text) {
        node = remove(node);
        continue;
      }
      node.data = text;
      prevText = node;
    } else if (node.nodeType === 1) {
      // Node.ELEMENT_NODE
      if (isBlock(node) || node.nodeName === 'BR') {
        if (prevText) {
          prevText.data = dropFinalSpace(prevText.data); // PATCH (j)
        }
        prevText = null;
        keepLeadingWs = false;
      } else if (isVoid(node) || isPre(node)) {
        // Avoid trimming space around non-block, non-BR void elements and inline PRE.
        prevText = null;
        keepLeadingWs = true;
      } else if (prevText) {
        // Drop protection if set previously.
        keepLeadingWs = false;
      }
    } else {
      node = remove(node);
      continue;
    }
    var nextNode = next(prev, node, isPre);
    prev = node;
    node = nextNode;
  }
  if (prevText) {
    prevText.data = dropFinalSpace(prevText.data); // PATCH (j)
    if (!prevText.data) {
      remove(prevText);
    }
  }
}

// PATCH (j): String.prototype.trim() (it strips exactly \s, which isWsAt()
// matches) as checked scans, on a long string.
function trimWs(s) {
  if (!bound || s.length <= bound.chunkSize) return s.trim();
  var start = scanWhile(s, 0, isWsAt);
  var end = s.length;
  while (end > start && isWsAt(s, end - 1)) {
    end--;
    if ((end & CHUNK_MASK) === 0) checkDeadline(bound);
  }
  return s.substring(start, end);
}
// PATCH (j): / $/.test(s) and s.replace(/ $/, '') without a regex scan.
function endsWithSpace(s) {
  return s.charCodeAt(s.length - 1) === 32;
}
function dropFinalSpace(s) {
  return endsWithSpace(s) ? s.substring(0, s.length - 1) : s;
}

/**
 * remove(node) removes the given node from the DOM and returns the
 * next node in the sequence.
 *
 * @param {Node} node
 * @return {Node} node
 */
function remove(node) {
  var next = node.nextSibling || node.parentNode;
  node.parentNode.removeChild(node);
  return next;
}

/**
 * next(prev, current, isPre) returns the next node in the sequence, given the
 * current and previous nodes.
 *
 * @param {Node} prev
 * @param {Node} current
 * @param {Function} isPre
 * @return {Node}
 */
function next(prev, current, isPre) {
  if (prev && prev.parentNode === current || isPre(current)) {
    return current.nextSibling || current.parentNode;
  }
  return current.firstChild || current.nextSibling || current.parentNode;
}

// PATCH (a): the caller hands over a node it owns (src/markdown.ts parses the
// page itself, in bounded slices). It is converted in place: never cloned, and
// never parsed from a string here, so this file needs no HTML parser at all.
function RootNode(input, options, service) {
  var root = input;
  // PATCH (h): every removal collapseWhitespace() makes calls domino's
  // modify(), which walks ALL ancestors while the document's private
  // `modclock` is non-zero: O(depth) per removed node. With it at 0 modify()
  // returns at once; the clock is then restored, advanced, and the root
  // marked modified. Only live collections taken on this subtree before the
  // conversion (fetch-mcp takes none) could miss the removals.
  var doc = root.nodeType === 9 ? root : root.ownerDocument;
  var clock = doc ? doc.modclock : 0;
  if (clock) doc.modclock = 0;
  try {
    collapseWhitespace({
      element: root,
      isBlock: isBlock,
      isVoid: isVoid,
      isPre: options.preformattedCode ? isPreOrCode : null,
      service: service
    });
  } finally {
    if (clock) {
      doc.modclock = clock + 1;
      if (typeof root.modify === 'function') root.modify();
    }
  }
  precomputeFacts(root, service); // PATCH (f)
  return root;
}
function isPreOrCode(node) {
  return node.nodeName === 'PRE' || node.nodeName === 'CODE';
}

function Node(node, options) {
  node.isBlock = isBlock(node);
  node.isCode = node.nodeName === 'CODE' || node.parentNode.isCode;
  node.isBlank = isBlank(node);
  node.flankingWhitespace = flankingWhitespace(node, options);
  return node;
}
function isBlank(node) {
  // PATCH (f): text and elements read the precomputed facts. Anything else
  // (a comment kept inside <pre>) is a leaf: its textContent is its own data.
  if (node.nodeType === 1) {
    return !isVoid(node) && !isMeaningfulWhenBlank(node) && node._tdWs && !hasVoid(node) && !hasMeaningfulWhenBlank(node);
  }
  if (node.nodeType === 3) return node._tdWs;
  // PATCH (j): a comment or CDATA node (inside <pre>, or <svg>) is never
  // converted -- process() gives it '' -- and only elements' isBlank and
  // flankingWhitespace are read, so upstream's scan of its text is skipped.
  return false;
}
function flankingWhitespace(node, options) {
  if (node.isBlock || options.preformattedCode && node.isCode) {
    return {
      leading: '',
      trailing: ''
    };
  }
  // PATCH (f): edgeWhitespace()'s split, from the precomputed runs. For
  // whitespace-only text, leading is the whole text and trailing is empty.
  if (node.nodeType === 1 || node.nodeType === 3) {
    // PATCH (k): the precomputed rests, not substring(): an element's runs are
    // ropes shared with its ancestors', and substring() flattens a rope in
    // place, which kept one copy of the text per level of nesting.
    var leading = node._tdLead;
    var trailing = node._tdWs ? '' : node._tdTrail;
    if (node._tdLeadAscii > 0 && isFlankedByWhitespace('left', node, options)) {
      leading = node._tdLeadRest;
    }
    if (!node._tdWs && node._tdTrailAscii > 0 && isFlankedByWhitespace('right', node, options)) {
      trailing = node._tdTrailRest;
    }
    return {
      leading: leading,
      trailing: trailing
    };
  }
  // PATCH (j): unread for other node types (see isBlank()).
  if (node.nodeType !== 1 && node.nodeType !== 3) return {
    leading: '',
    trailing: ''
  };
  var edges = edgeWhitespace(node.textContent);

  // abandon leading ASCII WS if left-flanked by ASCII WS
  if (edges.leadingAscii && isFlankedByWhitespace('left', node, options)) {
    edges.leading = edges.leadingNonAscii;
  }

  // abandon trailing ASCII WS if right-flanked by ASCII WS
  if (edges.trailingAscii && isFlankedByWhitespace('right', node, options)) {
    edges.trailing = edges.trailingNonAscii;
  }
  return {
    leading: edges.leading,
    trailing: edges.trailing
  };
}
function edgeWhitespace(string) {
  var m = string.match(/^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$/);
  return {
    leading: m[1],
    // whole string for whitespace-only strings
    leadingAscii: m[2],
    leadingNonAscii: m[3],
    trailing: m[4],
    // empty for whitespace-only strings
    trailingNonAscii: m[5],
    trailingAscii: m[6]
  };
}
function isFlankedByWhitespace(side, node, options) {
  var sibling;
  var regExp;
  var isFlanked;
  if (side === 'left') {
    sibling = node.previousSibling;
    regExp = / $/;
  } else {
    sibling = node.nextSibling;
    regExp = /^ /;
  }
  // PATCH (f): / $/ and /^ / look only at the last / first character, which
  // (f) recorded for text and elements alike: no textContent per sibling.
  if (sibling) {
    if (sibling.nodeType === 3) {
      isFlanked = (side === 'left' ? sibling._tdLast : sibling._tdFirst) === 32;
    } else if (options.preformattedCode && sibling.nodeName === 'CODE') {
      isFlanked = false;
    } else if (sibling.nodeType === 1 && !isBlock(sibling)) {
      isFlanked = (side === 'left' ? sibling._tdLast : sibling._tdFirst) === 32;
    }
  }
  return isFlanked;
}

// PATCH (f): per-node text facts, computed once per conversion. `\s` is the
// class upstream's /^\s*$/ and edgeWhitespace() use; [ \t\r\n] is
// edgeWhitespace()'s ASCII whitespace.
// PATCH (j): \s without a regex test per character: ECMAScript WhiteSpace
// (TAB VT FF SP NBSP ZWNBSP and Unicode Zs) plus LineTerminator.
function isWsAt(string, i) {
  var c = string.charCodeAt(i);
  if (c === 32 || c >= 9 && c <= 13) return true;
  if (c < 160) return false;
  return c === 0xa0 || c === 0x1680 || c >= 0x2000 && c <= 0x200a || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
function isAsciiWsCode(c) {
  return c === 32 || c === 9 || c === 13 || c === 10;
}
function setTextFacts(node, string) {
  var n = string.length;
  var i = scanWhile(string, 0, isWsAt); // PATCH (j): checked scans
  var leadAscii = scanWhile(string, 0, isAsciiWsAt);
  if (leadAscii > i) leadAscii = i;
  var j = 0; // start of the trailing whitespace run
  if (i < n) {
    j = n;
    while (j > i && isWsAt(string, j - 1)) {
      j--;
      if ((j & CHUNK_MASK) === 0) checkDeadline(bound);
    }
  }
  var trailAscii = 0;
  while (n - trailAscii > j && isAsciiWsCode(string.charCodeAt(n - 1 - trailAscii))) {
    trailAscii++;
    if ((trailAscii & CHUNK_MASK) === 0) checkDeadline(bound);
  }
  node._tdWs = i === n;
  node._tdLead = i === n ? string : string.substring(0, i);
  node._tdLeadAscii = leadAscii;
  node._tdTrail = i === n ? string : string.substring(j);
  node._tdTrailAscii = trailAscii;
  // PATCH (k): the runs without their ASCII edge, for flankingWhitespace().
  node._tdLeadRest = string.substring(leadAscii, i);
  node._tdTrailRest = string.substring(j, n - trailAscii);
  node._tdLen = n;
  node._tdFirst = n ? string.charCodeAt(0) : -1;
  node._tdLast = n ? string.charCodeAt(n - 1) : -1;
  node._tdHasVoid = false;
  node._tdHasMwb = false;
}
// Combines the children's facts (textContent is the concatenation of the
// descendant text nodes; comments and the like add nothing).
function setElementFacts(el) {
  var hasVoidBelow = false;
  var hasMwbBelow = false;
  var len = 0;
  var first = -1;
  var lead = '';
  var leadRest = ''; // PATCH (k): lead without its ASCII prefix
  var leadAscii = 0;
  var leadAsciiOpen = true;
  var ws = true;
  var olIndex = el.nodeName === 'OL' ? 0 : -1;
  var c, type;
  for (c = el.firstChild; c; c = c.nextSibling) {
    type = c.nodeType;
    if (type === 1) {
      if (c._tdHasVoid || isVoid(c)) hasVoidBelow = true;
      if (c._tdHasMwb || isMeaningfulWhenBlank(c)) hasMwbBelow = true;
      if (olIndex >= 0) c._tdIndex = olIndex++;
    } else if (type !== 3) {
      continue;
    }
    len += c._tdLen;
    if (first < 0) first = c._tdFirst;
    if (ws) {
      if (leadAsciiOpen) {
        leadAscii += c._tdLeadAscii;
        if (c._tdLeadAscii < c._tdLead.length) {
          leadAsciiOpen = false;
          leadRest = c._tdLeadRest; // PATCH (k)
        }
      } else {
        leadRest += c._tdLead; // PATCH (k)
      }
      lead += c._tdLead;
      if (!c._tdWs) ws = false;
    }
  }
  var trail = '';
  var trailRest = ''; // PATCH (k): the trail (the lead, if ws) without its ASCII suffix
  var trailAscii = 0;
  var trailAsciiOpen = true;
  var last = -1;
  for (c = el.lastChild; c; c = c.previousSibling) {
    type = c.nodeType;
    if (type !== 1 && type !== 3) continue;
    if (last < 0) last = c._tdLast;
    if (trailAsciiOpen) {
      trailAscii += c._tdTrailAscii;
      if (c._tdTrailAscii < c._tdTrail.length) {
        trailAsciiOpen = false;
        trailRest = c._tdTrailRest; // PATCH (k)
      }
    } else {
      trailRest = c._tdTrail + trailRest; // PATCH (k)
    }
    if (!ws) trail = c._tdTrail + trail;
    if (!c._tdWs) break;
    // PATCH (k): a whitespace-only element walks all its children, so that
    // trailRest covers the whole text (O(children), like the forward loop).
  }
  el._tdWs = ws;
  el._tdLead = lead;
  el._tdLeadRest = leadRest;
  el._tdLeadAscii = leadAscii;
  el._tdTrail = ws ? lead : trail;
  el._tdTrailRest = trailRest;
  el._tdTrailAscii = trailAscii;
  el._tdLen = len;
  el._tdFirst = first;
  el._tdLast = last;
  el._tdHasVoid = hasVoidBelow;
  el._tdHasMwb = hasMwbBelow;
}
// Pre-order with an explicit stack (recursion is what a deep page attacks),
// then the elements in reverse, so every child is done before its parent.
function precomputeFacts(root, service) {
  var order = [];
  var stack = [root];
  while (stack.length) {
    var el = stack.pop();
    checkDeadline(service); // PATCH (e)
    order.push(el);
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) stack.push(c);else if (c.nodeType === 3) setTextFacts(c, c.data);
    }
  }
  for (var i = order.length - 1; i >= 0; i--) {
    checkDeadline(service); // PATCH (e)
    setElementFacts(order[i]);
  }
}

// PATCH (e): throws once the instance's deadline has passed.
function checkDeadline(service) {
  if (service && service.deadline !== undefined && performance.now() > service.deadline) {
    throw new ConversionDeadlineError();
  }
}
// PATCH (g): charge `amount` characters of work BEFORE doing it.
var WORK_CHECK_EVERY = 65536;
function charge(service, amount) {
  var work = service.work += amount;
  if (service.maxWork !== undefined && work > service.maxWork) throw new ConversionLimitError(service.maxWork, 'work');
  if (work >= service.workCheckAt) {
    service.workCheckAt = work + WORK_CHECK_EVERY;
    checkDeadline(service);
  }
}

// PATCH (k): named so Rules can tell the defaults, which ignore `content`.
function defaultBlankReplacement(content, node) {
  return node.isBlock ? '\n\n' : '';
}
function defaultKeepReplacement(content, node) {
  return node.isBlock ? '\n\n' + node.outerHTML + '\n\n' : node.outerHTML;
}
function TurndownService(options) {
  if (!(this instanceof TurndownService)) return new TurndownService(options);
  var defaults = {
    rules: rules,
    headingStyle: 'setext',
    hr: '* * *',
    bulletListMarker: '*',
    codeBlockStyle: 'indented',
    fence: '```',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    linkReferenceStyle: 'full',
    br: '  ',
    preformattedCode: false,
    blankReplacement: defaultBlankReplacement,
    keepReplacement: defaultKeepReplacement,
    defaultReplacement: function (content, node) {
      return node.isBlock ? '\n\n' + content + '\n\n' : content;
    }
  };
  this.options = extend({}, defaults, options);
  this.rules = new Rules(this.options);
}
TurndownService.prototype = {
  /**
   * The entry point for converting a string or DOM node to Markdown
   * @public
   * @param {String|HTMLElement} input The string or DOM node to convert
   * @returns A Markdown representation of the input
   * @type String
   */

  turndown: function (input) {
    if (!canConvert(input)) {
      throw new TypeError(input + ' is not an element/document/fragment node.');
    }
    // PATCH (g): fresh counters per conversion.
    this.work = 0;
    this.workCheckAt = WORK_CHECK_EVERY;
    // PATCH (j): the helpers find this instance through `bound`.
    if (!(this.chunkSize > 0)) this.chunkSize = CHUNK;
    var previous = bound;
    bound = this;
    try {
      var output = process.call(this, new RootNode(input, this.options, this));
      return postProcess.call(this, output);
    } finally {
      bound = previous;
    }
  },
  /**
   * Add one or more plugins
   * @public
   * @param {Function|Array} plugin The plugin or array of plugins to add
   * @returns The Turndown instance for chaining
   * @type Object
   */

  use: function (plugin) {
    if (Array.isArray(plugin)) {
      for (var i = 0; i < plugin.length; i++) this.use(plugin[i]);
    } else if (typeof plugin === 'function') {
      plugin(this);
    } else {
      throw new TypeError('plugin must be a Function or an Array of Functions');
    }
    return this;
  },
  /**
   * Adds a rule
   * @public
   * @param {String} key The unique key of the rule
   * @param {Object} rule The rule
   * @returns The Turndown instance for chaining
   * @type Object
   */

  addRule: function (key, rule) {
    this.rules.add(key, rule);
    return this;
  },
  /**
   * Keep a node (as HTML) that matches the filter
   * @public
   * @param {String|Array|Function} filter The unique key of the rule
   * @returns The Turndown instance for chaining
   * @type Object
   */

  keep: function (filter) {
    this.rules.keep(filter);
    return this;
  },
  /**
   * Remove a node that matches the filter
   * @public
   * @param {String|Array|Function} filter The unique key of the rule
   * @returns The Turndown instance for chaining
   * @type Object
   */

  remove: function (filter) {
    this.rules.remove(filter);
    return this;
  },
  /**
   * Escapes Markdown syntax
   * @public
   * @param {String} string The string to escape
   * @returns A string with Markdown syntax escaped
   * @type String
   */

  escape: function (string) {
    return escapeMarkdown(string);
  }
};

/**
 * Reduces a DOM node down to its Markdown string equivalent
 * @private
 * @param {HTMLElement} parentNode The node to convert
 * @returns A Markdown representation of the node
 * @type String
 */

function process(parentNode) {
  var self = this;
  // PATCH (b): linear equivalent of reduce(join). The accumulated output is
  // always parts.join('') followed by `trail` newlines, so join() never
  // re-slices a growing string (upstream is quadratic in the child count).
  var parts = [];
  var trail = 0;
  var total = 0;
  var kids = parentNode.childNodes;
  for (var i = 0; i < kids.length; i++) {
    // PATCH (e): the conversion deadline, checked at every node.
    if (self.deadline !== undefined) {
      self.visited++;
      if (performance.now() > self.deadline) throw new ConversionDeadlineError();
    }
    var node = new Node(kids[i], self.options);
    var replacement = '';
    if (node.nodeType === 3) {
      charge(self, node.nodeValue.length); // PATCH (g): the escape
      replacement = node.isCode ? node.nodeValue : self.escape(node.nodeValue);
    } else if (node.nodeType === 1) {
      replacement = replacementForNode.call(self, node);
    }
    // PATCH (j): a rule's result is a rope that the first read below copies
    // flat; on a long one, check the deadline between that copy and the last.
    if (replacement.length > CHUNK) checkDeadline(self);
    var lead = scanWhile(replacement, 0, isNewlineAt); // PATCH (j)
    var sep = '\n\n'.substring(0, Math.max(trail, lead));
    if (lead === replacement.length) {
      trail = sep.length;
      continue;
    }
    var end = replacement.length;
    while (end > lead && replacement.charCodeAt(end - 1) === 10) {
      end--;
      if ((end & CHUNK_MASK) === 0) checkDeadline(self); // PATCH (j)
    }
    total += sep.length + end - lead;
    // PATCH (g): the output cap, checked before this parent's join builds it.
    if (self.maxOutput !== undefined && total > self.maxOutput) throw new ConversionLimitError(self.maxOutput);
    parts.push(sep, lead === 0 && end === replacement.length ? replacement : replacement.substring(lead, end));
    trail = replacement.length - end;
  }
  charge(self, total); // PATCH (g): the join
  return parts.join('') + '\n'.repeat(trail);
}

/**
 * Appends strings as each rule requires and trims the output
 * @private
 * @param {String} output The conversion output
 * @returns A trimmed version of the ouput
 * @type String
 */

function postProcess(output) {
  var self = this;
  this.rules.forEach(function (rule) {
    if (typeof rule.append === 'function') {
      output = join(output, rule.append(self.options));
    }
  });
  // PATCH (c): trim trailing whitespace with a loop. /[\t\r\n\s]+$/ is
  // quadratic on a long whitespace run that is not at the end. \s already
  // covers \t \r \n, so the character set is the same.
  // PATCH (j): /^[\t\r\n]+/ and the trailing \s run as checked scans.
  output = output.substring(scanWhile(output, 0, isTabCrLfAt));
  var end = output.length;
  while (end > 0 && isWsAt(output, end - 1)) {
    end--;
    if ((end & CHUNK_MASK) === 0) checkDeadline(this);
  }
  return output.substring(0, end);
}
function isTabCrLfAt(s, i) {
  var c = s.charCodeAt(i);
  return c === 9 || c === 13 || c === 10;
}

/**
 * Converts an element node to its Markdown equivalent
 * @private
 * @param {HTMLElement} node The node to convert
 * @returns A Markdown representation of the node
 * @type String
 */

function replacementForNode(node) {
  var rule = this.rules.forNode(node);
  var whitespace = node.flankingWhitespace;
  // PATCH (k): a rule that ignores its content (the blank rule, remove(),
  // keep(), and rules marked `ignoresContent`) gets '' without process()ing
  // the subtree or trimming the result, both of which it would discard.
  if (rule.ignoresContent === true) {
    charge(this, whitespace.leading.length + whitespace.trailing.length);
    return emitReplacement(whitespace.leading, rule.replacement('', node, this.options), whitespace.trailing);
  }
  var content = process.call(this, node);
  // PATCH (g): the trim and the rule work through the whole content, and a
  // fenced/indented code block reads its <code> element's textContent.
  var cost = content.length + whitespace.leading.length + whitespace.trailing.length;
  if (node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE') cost += node.firstChild._tdLen;
  charge(this, cost);
  if (whitespace.leading || whitespace.trailing) content = trimWs(content); // PATCH (j)
  return emitReplacement(whitespace.leading, rule.replacement(content, node, this.options), whitespace.trailing);
}
// PATCH (k): leading + replacement + trailing. When the rule gave '' and one
// side is '', that sum IS the other side's cached rope (V8 returns the
// non-empty operand), and process() reading it would flatten that rope in
// place: the rope is shared with every ancestor's, so each level of nesting
// would keep its own flat copy (O(depth x text) of heap). A fresh cons is
// flattened instead, which leaves the cached rope as it was.
function emitReplacement(leading, replacement, trailing) {
  if (replacement.length === 0 && (leading.length === 0 || trailing.length === 0)) {
    var side = leading.length === 0 ? trailing : leading;
    return side.length > 1 ? ('\n' + side).substring(1) : side;
  }
  return leading + replacement + trailing;
}

/**
 * Joins replacement to the current output with appropriate number of new lines
 * @private
 * @param {String} output The current conversion output
 * @param {String} replacement The string to append to the output
 * @returns Joined output
 * @type String
 */

function join(output, replacement) {
  var s1 = trimTrailingNewlines(output);
  var s2 = trimLeadingNewlines(replacement);
  var nls = Math.max(output.length - s1.length, replacement.length - s2.length);
  var separator = '\n\n'.substring(0, nls);
  return s1 + separator + s2;
}

/**
 * Determines whether an input can be converted
 * @private
 * @param {String|HTMLElement} input Describe this parameter
 * @returns Describe what it returns
 * @type String|Object|Array|Boolean|Number
 */

function canConvert(input) {
  // PATCH (a): nodes only; strings are parsed by the caller.
  return input != null && typeof input === 'object' && (input.nodeType === 1 || input.nodeType === 9 || input.nodeType === 11);
}

/**
 * PATCH (e): thrown by process() once `deadline` (a performance.now() value)
 * has passed.
 */
class ConversionDeadlineError extends Error {
  constructor() {
    super('HTML-to-markdown conversion deadline exceeded');
    this.name = 'ConversionDeadlineError';
  }
}

/**
 * PATCH (g): thrown once the output collected for one parent passes the
 * instance's `maxOutput` (characters; `kind` 'output'), or the replacement
 * work charged so far passes its `maxWork` (characters; `kind` 'work').
 */
class ConversionLimitError extends Error {
  constructor(limit, kind) {
    super('HTML-to-markdown ' + (kind || 'output') + ' limit exceeded');
    this.name = 'ConversionLimitError';
    this.limit = limit;
    this.kind = kind || 'output';
  }
}

export { TurndownService as default, ConversionDeadlineError, ConversionLimitError };
