// Several sections mapped to one Jira text field (Jira REQ21, Jira Sync REQ17).
// Jira holds them as one text: the first section's, then each other one that
// holds anything under a heading of its title, a checklist as a task list. A
// read splits that text at the headings into one part per section, each kept
// under a field id of its own (`description#acceptance-criteria`), so a pull
// and a sync compare, record, and settle every section as they would a field
// of its own; only a write puts the parts back together into the one field.
import type { Pair } from './connections.ts';
import type { Issue } from './pull.ts';
import type { BoardSettings, SectionDeclaration } from './types.ts';

// the Jira field a part's id belongs to, before this mark
const PART = '#';

export interface Bundle {
  // the Jira field
  field: string;
  // its sections' sides in the mapping's order; the first keeps the field's own id
  sides: string[];
}

// A field's own id for a part's (`description#acceptance-criteria` is the description).
export const realField = (id: string): string => (id.includes(PART) ? id.slice(0, id.indexOf(PART)) : id);

const partOf = (field: string, side: string): string => `${field}${PART}${side.slice('section:'.length)}`;

// The Jira fields more than one section is mapped to, among one issue type's pairs.
export function bundlesOf(pairs: Pair[]): Bundle[] {
  const sides = new Map<string, string[]>();
  for (const pair of pairs) {
    if (!pair.eidos.startsWith('section:')) continue;
    sides.set(pair.jira, [...(sides.get(pair.jira) ?? []), pair.eidos]);
  }
  return [...sides].filter(([, held]) => held.length > 1).map(([field, held]) => ({ field, sides: held }));
}

// The pairs as a read sees them: every section of a bundle but the first given its part's id.
export function partPairs(pairs: Pair[], bundles: Bundle[]): Pair[] {
  return pairs.map((pair) => {
    const bundle = bundles.find((held) => held.field === pair.jira);
    return bundle && bundle.sides.indexOf(pair.eidos) > 0 ? { ...pair, jira: partOf(bundle.field, pair.eidos) } : pair;
  });
}

// A section's declaration, from the default type's sections or any type's.
export function sectionOf(board: BoardSettings, side: string): SectionDeclaration | undefined {
  const key = side.slice('section:'.length);
  return [...board.sections, ...board.types.flatMap((type) => type.sections)].find((section) => section.key === key);
}

type Node = { type?: string; version?: number; content?: Node[]; text?: string };

const plain = (node: Node): string => (node.text ?? '') + (node.content ?? []).map(plain).join('');
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// An issue as a read sees it: each bundled field split at its sections' headings, the first part under the field's
// own id and each other under its part's id. A section whose heading the text lacks is absent, its part undefined
// (an empty one is null), which a pull leaves as the root has it and a sync counts as unchanged in Jira.
export function splitIssue(issue: Issue, bundles: Bundle[], board: BoardSettings): { issue: Issue; absent: Set<string> } {
  const absent = new Set<string>();
  if (bundles.length === 0) return { issue, absent };
  const fields: Issue['fields'] = { ...issue.fields };
  for (const bundle of bundles) {
    const whole = issue.fields[bundle.field] as Node | null | undefined;
    const rest = bundle.sides.slice(1);
    const titles = rest.map((side) => sectionOf(board, side)?.title ?? side.slice('section:'.length));
    const parts = new Map<number, Node[]>();
    let at = 0;
    for (const node of typeof whole === 'object' && whole !== null && whole.type === 'doc' ? (whole.content ?? []) : []) {
      const heading = node.type === 'heading' ? titles.findIndex((title) => same(title, plain(node))) : -1;
      if (heading >= 0) {
        at = heading + 1;
        parts.set(at, parts.get(at) ?? []);
        continue;
      }
      parts.set(at, [...(parts.get(at) ?? []), node]);
    }
    const doc = (content: Node[]): Node | null => (content.length === 0 ? null : { type: 'doc', version: 1, content });
    // a text that is not a document (an older field, plain text) is the first section's whole
    fields[bundle.field] = typeof whole === 'object' && whole !== null && whole.type === 'doc' ? doc(parts.get(0) ?? []) : whole;
    rest.forEach((side, index) => {
      const held = parts.get(index + 1);
      if (held === undefined) absent.add(side);
      fields[partOf(bundle.field, side)] = held === undefined ? undefined : doc(held);
    });
  }
  return { issue: { ...issue, fields }, absent };
}

// A checklist's lines as Jira holds them: a task list, without the line numbers the Backlog writes.
export function checklistToJira(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^(\s*[-*] \[[ xX]\] )#\d+ /, '$1'))
    .join('\n');
}

// A task list read from Jira as a checklist's lines, numbered from 1.
export function checklistFromJira(text: string): string {
  let n = 0;
  return text
    .split('\n')
    .map((line) => {
      const match = /^\s*[-*] \[([ xX])\] (?:#\d+ )?(.*)$/.exec(line);
      if (!match) return line;
      n += 1;
      return `- [${match[1] === ' ' ? ' ' : 'x'}] #${n} ${match[2]}`;
    })
    .join('\n')
    .trim();
}

// The one text a bundle is written as: the first section's, then each other that holds anything under its title.
export function composeText(bundle: Bundle, values: Record<string, string>, board: BoardSettings): string {
  const blocks: string[] = [];
  bundle.sides.forEach((side, index) => {
    const section = sectionOf(board, side);
    let text = (values[side] ?? '').trim();
    if (section?.type === 'checklist') text = checklistToJira(text);
    if (index === 0) {
      if (text !== '') blocks.push(text);
      return;
    }
    if (text !== '') blocks.push(`## ${section?.title ?? side.slice('section:'.length)}\n\n${text}`);
  });
  return blocks.join('\n\n');
}
