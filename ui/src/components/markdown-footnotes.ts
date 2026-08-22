// GFM-style footnote rendering (`[^label]` references + `[^label]: text`
// definitions) as a local markdown-it plugin: ordered endnotes, navigable
// superscript references, and per-note backlinks, with no external dependency.
import type MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import { t } from "../i18n/index.ts";
import { escapeMarkdownHtml } from "./markdown-text.ts";

const FOOTNOTES_ENV_KEY = Symbol("markdownFootnotes");

type FootnoteRecord = {
  label: string;
  /** 1-based display number and anchor suffix, assigned by definition order. */
  n: number;
  /** Reference occurrences; each gets its own backlink target id. */
  count: number;
  text: string;
};

type FootnotesEnv = {
  list: FootnoteRecord[];
  byLabel: Map<string, FootnoteRecord>;
};

type FootnoteItem = FootnoteRecord & { children: Token[] };

function footnotesIn(env: unknown): FootnotesEnv | undefined {
  if (!env || typeof env !== "object") {
    return undefined;
  }
  return (env as Record<symbol, unknown>)[FOOTNOTES_ENV_KEY] as FootnotesEnv | undefined;
}

function requireFootnotes(env: unknown): FootnotesEnv {
  return (
    footnotesIn(env) ??
    ((env as Record<symbol, unknown>)[FOOTNOTES_ENV_KEY] = {
      list: [],
      byLabel: new Map<string, FootnoteRecord>(),
    })
  );
}

function footnoteDocId(env: unknown): string | undefined {
  const docId: unknown = (env as { docId?: unknown } | undefined)?.docId;
  return typeof docId === "string" && docId !== "" ? docId : undefined;
}

/** Anchor namespace keeps identical notes in adjacent transcript messages from
 *  sharing DOM ids; the base36 hash is selector-safe so ids need no escaping. */
function footnoteNamespace(env: unknown): string {
  return `${footnoteDocId(env) ?? ""}-`;
}

function footnoteNoteId(namespace: string, n: number): string {
  return `fn${namespace}${n}`;
}

function footnoteRefId(namespace: string, n: number, subId: number): string {
  return `fnref${namespace}${n}${subId > 0 ? `-${subId}` : ""}`;
}

function footnoteDefinitionRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) {
    return false;
  }
  const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
  const max = state.eMarks[startLine] ?? state.src.length;
  // Shortest definition is "[^x]:".
  if (
    start + 4 > max ||
    state.src.charCodeAt(start) !== 0x5b ||
    state.src.charCodeAt(start + 1) !== 0x5e
  ) {
    return false;
  }
  const close = state.src.indexOf("]", start + 2);
  if (close < start + 3 || close > max - 2 || state.src.charCodeAt(close + 1) !== 0x3a) {
    return false;
  }
  const label = state.src.slice(start + 2, close);
  // Labels stay on one line without whitespace or nested brackets; anything
  // else is prose (or a link reference), not a footnote.
  if (/[\s[]/.test(label)) {
    return false;
  }
  if (silent) {
    return true;
  }

  // Note body: this line's remainder plus continuation lines indented by at
  // least four columns; a blank or unindented line ends the note.
  let cursor = close + 2;
  while (cursor < max && /\s/.test(state.src.charAt(cursor))) {
    cursor += 1;
  }
  const lines = [state.src.slice(cursor, max)];
  let line = startLine + 1;
  while (line < endLine) {
    const contentStart = (state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0);
    const contentEnd = state.eMarks[line] ?? contentStart;
    if (contentStart === contentEnd || (state.sCount[line] ?? 0) < 4) {
      break;
    }
    lines.push(state.src.slice(contentStart, contentEnd));
    line += 1;
  }

  const footnotes = requireFootnotes(state.env);
  const key = label.toLowerCase();
  // Duplicate labels merge into the first note, matching reference semantics.
  if (!footnotes.byLabel.has(key)) {
    const record: FootnoteRecord = {
      label,
      n: footnotes.list.length + 1,
      count: 0,
      text: lines.join("\n").trim(),
    };
    footnotes.list.push(record);
    footnotes.byLabel.set(key, record);
  }
  state.line = line;
  return true;
}

function footnoteReferenceRule(state: StateInline, silent: boolean): boolean {
  const pos = state.pos;
  const src = state.src;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5e) {
    return false;
  }
  const close = src.indexOf("]", pos + 2);
  if (close < pos + 3) {
    return false;
  }
  const label = src.slice(pos + 2, close);
  if (/[\s[]/.test(label)) {
    return false;
  }
  const record = footnotesIn(state.env)?.byLabel.get(label.toLowerCase());
  // Undefined labels keep their literal source text instead of a dead anchor.
  if (!record) {
    return false;
  }
  if (!silent) {
    const subId = record.count;
    record.count += 1;
    const token = state.push("footnote_ref", "", 0);
    token.meta = { n: record.n, subId };
  }
  state.pos = close + 1;
  return true;
}

function footnotesTailRule(state: StateCore): void {
  const footnotes = footnotesIn(state.env);
  if (!footnotes || footnotes.list.length === 0) {
    return;
  }
  const items: FootnoteItem[] = footnotes.list.map((record): FootnoteItem => {
    const children: Token[] = [];
    state.md.inline.parse(record.text, state.md, state.env, children);
    return {
      label: record.label,
      n: record.n,
      count: record.count,
      text: record.text,
      children,
    };
  });
  const token = new state.Token("footnotes_block", "", 0);
  token.block = true;
  token.meta = { items };
  state.tokens.push(token);
}

export function installMarkdownFootnotes(markdownParser: MarkdownIt): void {
  markdownParser.block.ruler.before("reference", "footnote_definition", footnoteDefinitionRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  markdownParser.inline.ruler.before("link", "footnote_ref", footnoteReferenceRule);
  // Definitions may appear after their references, so the endnotes section can
  // only be built once the whole document has been tokenized.
  markdownParser.core.ruler.push("footnotes_tail", footnotesTailRule);

  markdownParser.renderer.rules.footnote_ref = (tokens, index, _options, env) => {
    const meta = tokens[index]?.meta as { n?: unknown; subId?: unknown } | undefined;
    const n = Number(meta?.n ?? 0);
    const subId = Number(meta?.subId ?? 0);
    const namespace = footnoteNamespace(env);
    return `<a class="footnote-ref" href="#${footnoteNoteId(namespace, n)}" id="${footnoteRefId(namespace, n, subId)}">${n}</a>`;
  };

  markdownParser.renderer.rules.footnotes_block = (tokens, index, options, env, self) => {
    const items = (tokens[index]?.meta as { items?: FootnoteItem[] } | undefined)?.items ?? [];
    if (items.length === 0) {
      return "";
    }
    const namespace = footnoteNamespace(env);
    const backLink = (n: number, subId: number) =>
      `<a class="footnote-backref" href="#${footnoteRefId(namespace, n, subId)}" aria-label="${escapeMarkdownHtml(t("common.back"))}">↩</a>`;
    const listItems = items
      .map((item) => {
        const backlinks = Array.from({ length: Math.max(item.count, 1) }, (_, subId) =>
          backLink(item.n, subId),
        ).join("");
        return `<li id="${footnoteNoteId(namespace, item.n)}" class="footnote-item"><p>${self.renderInline(item.children, options, env)}${backlinks}</p></li>`;
      })
      .join("\n");
    return `<hr class="footnotes-sep">\n<section class="footnotes">\n<ol class="footnotes-list">\n${listItems}\n</ol>\n</section>\n`;
  };
}
