// Markdown to Atlassian Document Format, the way back of adf.ts, for the
// text a sync or a create sends to Jira. It reads the markdown adf.ts writes
// (headings, lists, task lists, tables, code, quotes, rules, links, marks),
// so a field the person did not edit goes back as it came.
//
// What markdown cannot hold (a panel, a mention, an embedded file, a status
// lozenge) is kept by the issue's own document: each block of Jira's current
// document is known by the markdown it reads as, and a block of the text sent
// that still reads the same is sent as Jira's own node, untouched. Only the
// blocks the person changed are written fresh. `lostNodes` then names what a
// write would still take out of Jira, so it is shown and agreed to, never lost
// in silence.
import { adfToMarkdown, type AdfContext, type AdfNode } from './adf.ts';

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

// The blocks and mentions of Jira's current document, by the markdown each reads as.
export interface Known {
  blocks: Map<string, AdfNode>;
  // `@alias` (as the pull wrote a mention) to the mention node it was
  mentions: Map<string, AdfNode>;
}

const NO_CONTEXT: AdfContext = { mention: () => null, media: () => null };

export function knownOf(current: unknown, context: AdfContext = NO_CONTEXT): Known {
  const blocks = new Map<string, AdfNode>();
  const mentions = new Map<string, AdfNode>();
  const node = current as AdfNode | null;
  if (!node || typeof node !== 'object' || node.type !== 'doc') return { blocks, mentions };
  for (const block of node.content ?? []) {
    const text = adfToMarkdown({ type: 'doc', content: [block] }, context);
    if (text !== '' && !blocks.has(text)) blocks.set(text, block);
  }
  const walk = (at: AdfNode): void => {
    if (at.type === 'mention') {
      const token = adfToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [at] }] }, context);
      if (token.startsWith('@') && !mentions.has(token)) mentions.set(token, at);
    }
    for (const child of at.content ?? []) walk(child);
  };
  walk(node);
  return { blocks, mentions };
}

const EMPTY: Known = { blocks: new Map(), mentions: new Map() };

// ---- inline -----------------------------------------------------------------------

type Mark = { type: string; attrs?: Record<string, unknown> };

const text = (value: string, marks: Mark[]): AdfNode => (marks.length > 0 ? { type: 'text', text: value, marks: marks.map((mark) => ({ ...mark })) } : { type: 'text', text: value });

// The text and marks of one line, adjacent plain text joined so the same markdown always gives the same nodes.
function inline(source: string, known: Known, marks: Mark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  const push = (node: AdfNode): void => {
    const last = out[out.length - 1];
    if (node.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) last.text = (last.text ?? '') + (node.text ?? '');
    else out.push(node);
  };
  const mentions = [...known.mentions.keys()].sort((a, b) => b.length - a.length);
  let plain = '';
  const flush = (): void => {
    if (plain !== '') push(text(plain, marks));
    plain = '';
  };
  let at = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    const char = source[at]!;
    if (char === '\\' && at + 1 < source.length && /[\\`*_~[\]()<>!|#@.+-]/.test(source[at + 1]!)) {
      plain += source[at + 1];
      at += 2;
      continue;
    }
    if (char === '`') {
      const match = /^`((?:\\`|[^`])+)`/.exec(rest);
      if (match) {
        flush();
        push(text(match[1]!.replace(/\\`/g, '`'), [...marks.filter((mark) => mark.type === 'link'), { type: 'code' }]));
        at += match[0].length;
        continue;
      }
    }
    if (char === '*' && rest.startsWith('**')) {
      const end = closing(source, at + 2, '**');
      if (end > at + 2 && !/\s/.test(source[at + 2] ?? ' ') && !/\s/.test(source[end - 1] ?? ' ')) {
        flush();
        for (const node of inline(source.slice(at + 2, end), known, [...marks, { type: 'strong' }])) push(node);
        at = end + 2;
        continue;
      }
    }
    if (char === '~' && rest.startsWith('~~')) {
      const end = closing(source, at + 2, '~~');
      if (end > at + 2) {
        flush();
        for (const node of inline(source.slice(at + 2, end), known, [...marks, { type: 'strike' }])) push(node);
        at = end + 2;
        continue;
      }
    }
    if ((char === '*' || char === '_') && !rest.startsWith('**')) {
      const end = closing(source, at + 1, char);
      const wordy = char === '_' && /\w/.test(source[at - 1] ?? '');
      // an emphasis opens on a mark followed by text and closes on one that follows text, as markdown reads `a * b * c` as text
      const flanked = end > at + 1 && !/\s/.test(source[at + 1] ?? ' ') && !/\s/.test(source[end - 1] ?? ' ');
      if (flanked && !wordy) {
        flush();
        for (const node of inline(source.slice(at + 1, end), known, [...marks, { type: 'em' }])) push(node);
        at = end + 1;
        continue;
      }
    }
    if (char === '!' && rest.startsWith('![')) {
      // an image the root draws is a file Jira does not hold; it goes as a link to where it is
      const match = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
      if (match) {
        flush();
        push(text(match[1] || match[2]!, [...marks, { type: 'link', attrs: { href: match[2] } }]));
        at += match[0].length;
        continue;
      }
    }
    if (char === '[') {
      const match = linkAt(rest);
      if (match) {
        flush();
        const label = match[1]!;
        const nodes = label === '' ? [text(match[2]!, [])] : inline(label, known, []);
        for (const node of nodes) {
          if (node.type !== 'text') {
            push(node);
            continue;
          }
          const own = (node.marks ?? []).filter((mark) => mark.type !== 'link');
          push(text(node.text ?? '', [...marks, ...own, { type: 'link', attrs: { href: match[2] } }]));
        }
        at += match[0].length;
        continue;
      }
    }
    if (char === '<') {
      const match = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
      if (match) {
        flush();
        push({ type: 'inlineCard', attrs: { url: match[1] } });
        at += match[0].length;
        continue;
      }
    }
    if (char === '@') {
      const token = mentions.find((held) => rest.startsWith(held) && !/[\w-]/.test(rest[held.length] ?? ''));
      if (token) {
        flush();
        push(structuredClone(known.mentions.get(token)!));
        at += token.length;
        continue;
      }
    }
    plain += char;
    at += 1;
  }
  flush();
  return out;
}

// A link at the start of the text: its label and an address whose parentheses balance (`…/Foo_(bar)`), as markdown reads one.
function linkAt(rest: string): [string, string, string] | null {
  const label = /^\[((?:\\\]|[^\]])*)\]\(/.exec(rest);
  if (!label) return null;
  let depth = 0;
  for (let at = label[0].length; at < rest.length; at += 1) {
    const char = rest[at]!;
    if (/\s/.test(char)) return null;
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) {
        const href = rest.slice(label[0].length, at);
        return href === '' ? null : [rest.slice(0, at + 1), label[1]!, href];
      }
      depth -= 1;
    }
  }
  return null;
}

// Where a mark opened at `from` closes, skipping code spans and escapes; -1 for nowhere.
function closing(source: string, from: number, delimiter: string): number {
  for (let at = from; at < source.length; at += 1) {
    if (source[at] === '\\') {
      at += 1;
      continue;
    }
    if (source[at] === '`') {
      const end = source.indexOf('`', at + 1);
      if (end > at) at = end;
      continue;
    }
    if (source.startsWith(delimiter, at) && (delimiter !== '*' || source[at + 1] !== '*')) return at;
  }
  return -1;
}

// A paragraph's lines, each break a hard break, as adf.ts writes one.
function paragraph(lines: string[], known: Known): AdfNode {
  const content: AdfNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: 'hardBreak' });
    content.push(...inline(line.replace(/\s+$/, ''), known));
  });
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

// ---- blocks -----------------------------------------------------------------------

const BULLET = /^([-*+]) (.*)$/;
const ORDERED = /^(\d+)[.)] (.*)$/;
const TASK = /^[-*+] \[( |x|X)\] (.*)$/;
const FENCE = /^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6}) (.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const ROW = /^\|.*\|$/;
const DIVIDER = /^\|(\s*:?-{3,}:?\s*\|)+$/;

interface Piece {
  raw: string;
  node: AdfNode | null;
}

function starts(line: string): boolean {
  return BULLET.test(line) || ORDERED.test(line) || FENCE.test(line) || HEADING.test(line) || RULE.test(line.trim()) || line.startsWith('>') || ROW.test(line.trim());
}

// Cells of one table row, a `\|` held in its cell.
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cell = '';
  for (let at = 0; at < inner.length; at += 1) {
    if (inner[at] === '\\' && inner[at + 1] === '|') {
      cell += '|';
      at += 1;
    } else if (inner[at] === '|') {
      out.push(cell.trim());
      cell = '';
    } else cell += inner[at];
  }
  out.push(cell.trim());
  return out;
}

// One list's items from its first line on: an item's lines are those after its bullet that are indented under it (or blank between them).
function listItems(lines: string[], start: number, pattern: RegExp): { items: Array<{ marker: string; lines: string[] }>; end: number } {
  const items: Array<{ marker: string; lines: string[] }> = [];
  let at = start;
  while (at < lines.length) {
    const match = pattern.exec(lines[at]!);
    if (!match) break;
    const width = lines[at]!.length - match[2]!.length;
    const body = [match[2]!];
    at += 1;
    while (at < lines.length) {
      const line = lines[at]!;
      if (line.trim() === '') {
        const next = lines[at + 1];
        if (next !== undefined && next.startsWith(' '.repeat(width)) && next.trim() !== '') {
          body.push('');
          at += 1;
          continue;
        }
        break;
      }
      if (!line.startsWith(' '.repeat(width))) break;
      body.push(line.slice(width));
      at += 1;
    }
    items.push({ marker: match[1]!, lines: body });
    // a blank line between two items of the same list keeps the list going
    if (at < lines.length && lines[at]!.trim() === '' && pattern.test(lines[at + 1] ?? '')) at += 1;
  }
  return { items, end: at };
}

let localIds = 0;
const localId = (): string => `eidos-${(localIds += 1)}`;

function pieces(lines: string[], known: Known): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    if (line.trim() === '') {
      at += 1;
      continue;
    }
    const begin = at;
    const raw = (): string => lines.slice(begin, at).join('\n');
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !lines[at]!.startsWith(fence[1]!)) body.push(lines[at++]!);
      at += 1;
      out.push({ raw: raw(), node: { type: 'codeBlock', ...(fence[2] ? { attrs: { language: fence[2] } } : {}), ...(body.length > 0 ? { content: [{ type: 'text', text: body.join('\n') }] } : {}) } });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      at += 1;
      out.push({ raw: raw(), node: { type: 'heading', attrs: { level: heading[1]!.length }, content: inline(heading[2]!.trim(), known) } });
      continue;
    }
    if (RULE.test(line.trim())) {
      at += 1;
      out.push({ raw: raw(), node: { type: 'rule' } });
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (at < lines.length && lines[at]!.startsWith('>')) body.push(lines[at++]!.replace(/^> ?/, ''));
      out.push({ raw: raw(), node: { type: 'blockquote', content: blocksOf(body, known) } });
      continue;
    }
    if (ROW.test(line.trim()) && DIVIDER.test((lines[at + 1] ?? '').replace(/\s/g, ''))) {
      const rows: string[][] = [cells(line)];
      at += 2;
      while (at < lines.length && ROW.test(lines[at]!.trim())) rows.push(cells(lines[at++]!));
      const cell = (value: string, header: boolean): AdfNode => ({ type: header ? 'tableHeader' : 'tableCell', content: [paragraph([value], known)] });
      out.push({ raw: raw(), node: { type: 'table', content: rows.map((row, index) => ({ type: 'tableRow', content: row.map((value) => cell(value, index === 0)) })) } });
      continue;
    }
    if (TASK.test(line)) {
      const items: AdfNode[] = [];
      while (at < lines.length && TASK.test(lines[at]!)) {
        const match = TASK.exec(lines[at++]!)!;
        items.push({ type: 'taskItem', attrs: { localId: localId(), state: match[1] === ' ' ? 'TODO' : 'DONE' }, content: inline(match[2]!, known) });
      }
      out.push({ raw: raw(), node: { type: 'taskList', attrs: { localId: localId() }, content: items } });
      continue;
    }
    const ordered = ORDERED.test(line);
    if (ordered || BULLET.test(line)) {
      const { items, end } = listItems(lines, at, ordered ? ORDERED : BULLET);
      at = end;
      const first = Number(items[0]?.marker) || 1;
      out.push({
        raw: raw(),
        node: {
          type: ordered ? 'orderedList' : 'bulletList',
          ...(ordered ? { attrs: { order: first } } : {}),
          content: items.map((item) => ({ type: 'listItem', content: blocksOf(item.lines, known) })),
        },
      });
      continue;
    }
    const body: string[] = [];
    while (at < lines.length && lines[at]!.trim() !== '' && (at === begin || !starts(lines[at]!))) body.push(lines[at++]!);
    out.push({ raw: raw(), node: paragraph(body, known) });
  }
  return out;
}

function blocksOf(lines: string[], known: Known): AdfNode[] {
  const nodes = pieces(lines, known).flatMap((piece) => (piece.node ? [piece.node] : []));
  return nodes.length > 0 ? nodes : [{ type: 'paragraph' }];
}

// Markdown as a Jira document; a block that reads as one of Jira's current
// blocks is that block, so what markdown cannot hold survives an edit
// elsewhere in the text. Blocks are told apart as adf.ts joins them, by a
// blank line, so a known block that spans several (a panel's paragraphs) is
// found by trying each run of pieces that could make it up.
export function markdownToAdf(markdown: string, known: Known = EMPTY): AdfDoc {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const found = pieces(lines, known);
  const content: AdfNode[] = [];
  for (let at = 0; at < found.length; ) {
    let matched = 0;
    if (known.blocks.size > 0) {
      for (let span = found.length - at; span >= 1; span -= 1) {
        const raw = found
          .slice(at, at + span)
          .map((piece) => piece.raw.trim())
          .join('\n\n');
        const original = known.blocks.get(raw);
        if (original) {
          content.push(structuredClone(original));
          matched = span;
          break;
        }
      }
    }
    if (matched > 0) {
      at += matched;
      continue;
    }
    const node = found[at]!.node;
    if (node) content.push(node);
    at += 1;
  }
  return { type: 'doc', version: 1, content };
}

// ---- what a write would take out of Jira ----------------------------------------------

// The nodes and marks markdown does not hold, by kind, in a document.
const RICH_NODES = new Set([
  'panel',
  'expand',
  'nestedExpand',
  'mention',
  'media',
  'mediaSingle',
  'mediaGroup',
  'mediaInline',
  'status',
  'date',
  'emoji',
  'blockCard',
  'embedCard',
  'decisionList',
  'layoutSection',
  'extension',
  'bodiedExtension',
  'inlineExtension',
]);
const RICH_MARKS = new Set(['underline', 'textColor', 'subsup', 'backgroundColor', 'alignment', 'indentation', 'border']);

function richCount(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (node: AdfNode | undefined): void => {
    if (!node || typeof node !== 'object') return;
    if (RICH_NODES.has(node.type)) out.set(node.type, (out.get(node.type) ?? 0) + 1);
    for (const mark of node.marks ?? []) if (RICH_MARKS.has(mark.type)) out.set(`${mark.type} mark`, (out.get(`${mark.type} mark`) ?? 0) + 1);
    for (const child of node.content ?? []) walk(child);
  };
  walk(value as AdfNode);
  return out;
}

// What Jira holds now that markdown cannot write and the document to be sent no longer has, by kind and count:
// a panel the person rewrote, a mention in a paragraph they changed. Empty when nothing would be lost.
export function lostNodes(current: unknown, next: AdfDoc): Array<{ kind: string; count: number }> {
  const before = richCount(current);
  const after = richCount(next);
  return [...before]
    .map(([kind, count]) => ({ kind, count: count - (after.get(kind) ?? 0) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => a.kind.localeCompare(b.kind));
}
