// Matching the Backlog to a board (Jira REQ24), worked out from what
// `describe` last read and the Backlog's settings, nothing asked of Jira:
// the change the Backlog's `reshape` takes (Backlog REQ20) and the mapping
// that pairs each Jira value with its namesake once it is written.
//
//   add      every Jira value the Backlog lacks added; a Backlog value the
//            mapping reads from one Jira value alone renamed to it; nothing removed
//   replace  each list Jira's exactly; a Backlog value Jira lacks renamed as
//            above, else removed, its tasks moved to the Jira value the mapping
//            reads it as, else the first of its category (a priority by its rank)
import type { Mapping, Pair } from './connections.ts';
import type { Description } from './describe.ts';
import { backlogCategory, DEFAULT_TYPE, priorityFor, statusFor, typeFor } from './mapping.ts';
import type { BoardSettings, Reshape, StatusCategory } from './types.ts';

export type MatchMode = 'add' | 'replace';

// One list as it is and as it would be, what is renamed, added, and removed (with where its tasks go).
export interface MatchList {
  before: string[];
  after: string[];
  renamed: Record<string, string>;
  added: string[];
  removed: Array<{ value: string; to: string | null }>;
}

export interface MatchChange {
  change: Reshape;
  statuses: MatchList;
  priorities: MatchList;
  // types by their titles, as a person names them
  types: MatchList;
  mapping: Pick<Mapping, 'statuses' | 'priorities' | 'types'>;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// A Jira issue type's name as a task type's key: letters, digits, _ and -.
export const typeKey = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'type';

// The board's statuses in its order: each column's, then any other an issue type holds, once each, with its category.
function jiraStatuses(description: Description): Array<{ name: string; category: StatusCategory }> {
  const categories = new Map<string, StatusCategory>();
  for (const type of description.types.filter((each) => !each.subtask)) for (const status of type.statuses) if (!categories.has(status.name)) categories.set(status.name, status.category);
  const ordered = [...description.columns.flatMap((column) => column.statuses), ...categories.keys()];
  const seen = new Set<string>();
  return ordered.filter((name) => (seen.has(name.toLowerCase()) ? false : (seen.add(name.toLowerCase()), true))).map((name) => ({ name, category: categories.get(name) ?? 'todo' }));
}

// `list` with each added value placed after the value Jira holds before it, else first.
function inserted(list: string[], added: string[], jiraOrder: string[]): string[] {
  const out = [...list];
  for (const value of added) {
    const before = jiraOrder.slice(0, jiraOrder.indexOf(value)).reverse();
    const anchor = before.map((held) => out.findIndex((each) => same(each, held))).find((at) => at !== -1);
    out.splice(anchor === undefined ? 0 : anchor + 1, 0, value);
  }
  return out;
}

// Which Backlog value is renamed to which Jira value: one the mapping reads from that Jira value alone, Jira not holding its name already.
function renames(backlog: string[], jira: string[], readAs: (value: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of backlog) {
    if (jira.some((held) => held === value)) continue;
    const exact = jira.find((held) => same(held, value));
    // the same value in another case is Jira's spelling
    if (exact) {
      out[value] = exact;
      continue;
    }
    const sources = jira.filter((held) => readAs(held) === value);
    if (sources.length !== 1) continue;
    const target = sources[0]!;
    if (backlog.some((held) => same(held, target)) || Object.values(out).includes(target)) continue;
    out[value] = target;
  }
  return out;
}

// The Jira value a Backlog value's tasks go to when it leaves: the one the mapping reads as it (the one marked to send first), else `fallback`.
function readFrom(pairs: Pair[] | undefined, jira: string[], value: string, readAs: (held: string) => string | null, fallback: () => string | null): string | null {
  const reading = jira.filter((held) => readAs(held) === value);
  const pushed = reading.find((held) => pairs?.some((pair) => same(pair.jira, held) && pair.push === true));
  return pushed ?? reading[0] ?? fallback();
}

export function matchChange(description: Description, board: BoardSettings, mapping: Mapping, mode: MatchMode): MatchChange {
  // ---- statuses ----
  const jiraStatusList = jiraStatuses(description);
  const jiraStatusNames = jiraStatusList.map((status) => status.name);
  const categoryOfJira = new Map(jiraStatusList.map((status) => [status.name, status.category]));
  const statusRead = (jira: string): string => statusFor(mapping, board, jira, categoryOfJira.get(jira) ?? 'todo');
  const statusRenamed = renames(board.statuses, jiraStatusNames, statusRead);
  const keptStatuses = board.statuses.map((status) => statusRenamed[status] ?? status);
  const statusAdded = jiraStatusNames.filter((name) => !keptStatuses.some((held) => same(held, name)));
  const categoryOf = (status: string): StatusCategory => categoryOfJira.get(status) ?? backlogCategory(board, status);
  let statusAfter: string[];
  let columns: Array<{ name: string; statuses: string[] }>;
  const statusRemoved: MatchList['removed'] = [];
  const statusMoved: Record<string, string> = {};
  if (mode === 'replace') {
    statusAfter = jiraStatusNames;
    columns = description.columns.map((column) => ({ name: column.name, statuses: column.statuses.filter((status) => statusAfter.includes(status)) })).filter((column) => column.statuses.length > 0);
    for (const status of board.statuses) {
      if (statusRenamed[status] || statusAfter.includes(status)) continue;
      const category = backlogCategory(board, status);
      const to = readFrom(mapping.statuses, jiraStatusNames, status, statusRead, () => jiraStatusList.find((held) => held.category === category)?.name ?? jiraStatusNames[0] ?? null)!;
      statusRemoved.push({ value: status, to });
      statusMoved[status] = to;
    }
  } else {
    statusAfter = inserted(keptStatuses, statusAdded, jiraStatusNames);
    // a status added goes on the board where Jira shows it: in the column of that name, made when the Backlog has none
    columns = board.columns.map((column) => ({ name: column.name, statuses: column.statuses.map((status) => statusRenamed[status] ?? status) }));
    for (const status of statusAdded) {
      const jiraColumn = description.columns.find((column) => column.statuses.includes(status));
      if (!jiraColumn) continue;
      const column = columns.find((held) => same(held.name, jiraColumn.name));
      if (column) column.statuses.push(status);
      else columns.push({ name: jiraColumn.name, statuses: [status] });
    }
  }
  const followedDefault = statusRenamed[board.default_status] ?? board.default_status;
  const defaultStatus = statusAfter.includes(followedDefault) ? followedDefault : (statusAfter.find((status) => categoryOf(status) === 'todo') ?? statusAfter[0]!);

  // ---- priorities ----
  const jiraPriorities = description.priorities;
  const priorityRead = (jira: string): string | null => priorityFor(mapping, board, jira, jiraPriorities);
  const priorityRenamed = renames(board.priorities, jiraPriorities, priorityRead);
  const keptPriorities = board.priorities.map((priority) => priorityRenamed[priority] ?? priority);
  const priorityAdded = jiraPriorities.filter((name) => !keptPriorities.some((held) => same(held, name)));
  const priorityRemoved: MatchList['removed'] = [];
  const priorityMoved: Record<string, string | null> = {};
  let priorityAfter: string[];
  if (mode === 'replace') {
    priorityAfter = [...jiraPriorities];
    board.priorities.forEach((priority, index) => {
      if (priorityRenamed[priority] || priorityAfter.includes(priority)) return;
      // by its rank: the Jira priority as far down Jira's list as this one is down the Backlog's
      const byRank = (): string | null =>
        jiraPriorities.length === 0 ? null : jiraPriorities[Math.min(jiraPriorities.length - 1, Math.round((index / Math.max(1, board.priorities.length - 1)) * (jiraPriorities.length - 1)))]!;
      const to = readFrom(mapping.priorities, jiraPriorities, priority, priorityRead, byRank);
      priorityRemoved.push({ value: priority, to });
      priorityMoved[priority] = to;
    });
  } else priorityAfter = inserted(keptPriorities, priorityAdded, jiraPriorities);

  // ---- types: a task's type by its key, shown by its title; the default type stays, as the Jira type that reads as it ----
  const jiraTypes = description.types.filter((type) => !type.subtask).map((type) => type.name);
  const typeRead = (jira: string): string | null => typeFor(mapping, board, jira);
  const defaultJira = jiraTypes.find((name) => typeRead(name) === DEFAULT_TYPE) ?? jiraTypes.find((name) => same(name, 'Task')) ?? null;
  const titleOf = (key: string): string => board.types.find((type) => type.name === key)?.title ?? key;
  // the Backlog type a Jira type is, after the change: the default for its Jira type, one of its name or title, else one made from its name
  const keyFor = (jira: string): string => {
    if (jira === defaultJira) return DEFAULT_TYPE;
    const held = board.types.find((type) => type.name !== DEFAULT_TYPE && (same(type.name, jira) || same(type.title, jira) || type.name === typeKey(jira)));
    return held?.name ?? typeKey(jira);
  };
  const typeRenamed: Record<string, string> = {};
  for (const type of board.types) {
    if (type.name === DEFAULT_TYPE || jiraTypes.some((jira) => keyFor(jira) === type.name)) continue;
    const sources = jiraTypes.filter((jira) => jira !== defaultJira && typeRead(jira) === type.name && !board.types.some((other) => other !== type && other.name === keyFor(jira)));
    if (sources.length === 1) typeRenamed[type.name] = typeKey(sources[0]!);
  }
  const jiraTypeEntries = jiraTypes.map((jira) => ({ name: keyFor(jira), title: jira }));
  const keptTypes = board.types.map((type) => {
    const name = typeRenamed[type.name] ?? type.name;
    const jira = jiraTypeEntries.find((entry) => entry.name === name);
    return { name, title: jira?.title ?? type.title };
  });
  const typeAdded = jiraTypeEntries.filter((entry) => !keptTypes.some((held) => held.name === entry.name));
  const typeRemoved: MatchList['removed'] = [];
  const typeMoved: Record<string, string> = {};
  let typeAfter: Array<{ name: string; title: string }>;
  if (mode === 'replace') {
    typeAfter = [...jiraTypeEntries];
    if (!typeAfter.some((entry) => entry.name === DEFAULT_TYPE)) typeAfter.unshift({ name: DEFAULT_TYPE, title: titleOf(DEFAULT_TYPE) });
    for (const type of board.types) {
      if (typeRenamed[type.name] || typeAfter.some((entry) => entry.name === type.name)) continue;
      const jira = readFrom(mapping.types, jiraTypes, type.name, typeRead, () => null);
      const to = jira ? keyFor(jira) : DEFAULT_TYPE;
      typeRemoved.push({ value: type.title, to: typeAfter.find((entry) => entry.name === to)?.title ?? to });
      typeMoved[type.name] = to;
    }
  } else {
    typeAfter = [...keptTypes];
    for (const entry of typeAdded) typeAfter.push(entry);
  }
  // the default type first, as the Backlog keeps it
  typeAfter = [...typeAfter.filter((entry) => entry.name === DEFAULT_TYPE), ...typeAfter.filter((entry) => entry.name !== DEFAULT_TYPE)];

  const change: Reshape = {
    statuses: {
      list: statusAfter.map((name) => ({ name, category: categoryOf(name) })),
      columns,
      default: defaultStatus,
      renamed: statusRenamed,
      moved: statusMoved,
    },
    priorities: { list: priorityAfter, renamed: priorityRenamed, moved: priorityMoved },
    types: { list: typeAfter, renamed: typeRenamed, moved: typeMoved },
  };

  // once written, each Jira value pairs with its namesake; a sub-task type keeps its pair, and a value Jira folds into another keeps reading as it
  const namesake = (pairs: Pair[] | undefined, values: string[], to: (jira: string) => string | null): Pair[] => {
    const kept = (pairs ?? []).filter((pair) => !values.some((value) => same(value, pair.jira)));
    return [...kept, ...values.flatMap((jira) => (to(jira) ? [{ ...((pairs ?? []).find((pair) => same(pair.jira, jira)) ?? {}), jira, eidos: to(jira)! }] : []))];
  };
  const statusOut = (jira: string): string | null => statusAfter.find((held) => same(held, jira)) ?? (mode === 'add' ? (statusRenamed[statusRead(jira)] ?? statusRead(jira)) : null);
  const priorityOut = (jira: string): string | null => priorityAfter.find((held) => same(held, jira)) ?? null;
  const typeOut = (jira: string): string | null => typeAfter.find((entry) => entry.title === jira)?.name ?? null;

  const titles = (list: Array<{ name: string; title: string }>): string[] => list.map((entry) => entry.title);
  return {
    change,
    statuses: { before: [...board.statuses], after: statusAfter, renamed: statusRenamed, added: statusAdded, removed: statusRemoved },
    priorities: { before: [...board.priorities], after: priorityAfter, renamed: priorityRenamed, added: priorityAdded, removed: priorityRemoved },
    types: {
      before: board.types.map((type) => type.title),
      after: titles(typeAfter),
      renamed: Object.fromEntries(Object.entries(typeRenamed).map(([from, to]) => [titleOf(from), typeAfter.find((entry) => entry.name === to)?.title ?? to])),
      added: titles(typeAdded),
      removed: typeRemoved,
    },
    mapping: {
      statuses: namesake(mapping.statuses, jiraStatusNames, statusOut),
      priorities: namesake(mapping.priorities, jiraPriorities, priorityOut),
      types: namesake(mapping.types, jiraTypes, typeOut),
    },
  };
}
