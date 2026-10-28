// A connection's mapping as a pull applies it, and its checks (Jira REQ7 to
// REQ13). Every part is optional: a part the mapping leaves out carries by
// name (every issue type into the Backlog's default type, every status by its
// category, a priority or a link type of the same name), and a part it gives
// carries only what it names. `fields` left out carries what every board has
// (REQ8). A pair is checked against the Jira field's schema and the Backlog's
// declarations (REQ9) and against the connection's direction (REQ10).
import { allFields, allStatuses, type Description, type JiraField } from './describe.ts';
import type { Connection, Mapping, MappingPart, Pair, ParentRule } from './connections.ts';
import type { BoardSettings, StatusCategory } from './types.ts';

export const DEFAULT_TYPE = 'default';

// Jira REQ8: what a connection that names no fields carries.
export function defaultFields(board: BoardSettings): Pair[] {
  const firstText = (board.types.find((type) => type.name === DEFAULT_TYPE)?.sections ?? board.sections).find((section) => section.type === 'text');
  return [
    { jira: 'summary', eidos: 'title' },
    ...(firstText ? [{ jira: 'description', eidos: `section:${firstText.key}` }] : []),
    { jira: 'status', eidos: 'status' },
    { jira: 'priority', eidos: 'priority' },
    { jira: 'assignee', eidos: 'assignee' },
    { jira: 'parent', eidos: 'parent' },
  ];
}

export function fieldsOf(connection: Connection, board: BoardSettings): Pair[] {
  return connection.mapping.fields ?? defaultFields(board);
}

// The field pairs that apply to one issue type: those naming it, and those naming none; a pair naming the type wins
// over one naming none for the same Jira field.
export function fieldsFor(pairs: Pair[], issueType: string): Pair[] {
  const own = (pair: Pair): boolean => (pair.types ?? []).some((type) => type.toLowerCase() === issueType.toLowerCase());
  const named = pairs.filter(own);
  return [...named, ...pairs.filter((pair) => !pair.types?.length && !named.some((held) => held.jira === pair.jira))];
}

// A Backlog status's category, as the Backlog reads one: the root's choice,
// else its place (the Backlog's own statusCategory, which its API does not
// hand out; kept the same here).
export function backlogCategory(board: BoardSettings, status: string): StatusCategory {
  const chosen = board.status_categories?.[status];
  if (chosen) return chosen;
  const onBoard = new Set(board.columns.flatMap((column) => column.statuses));
  const lastOnBoard = board.statuses.reduce((at, held, index) => (onBoard.has(held) ? index : at), -1);
  const after = lastOnBoard === -1 ? [] : board.statuses.slice(lastOnBoard + 1).filter((held) => !onBoard.has(held));
  const finished = after.length > 0 ? after : (board.columns[board.columns.length - 1]?.statuses ?? []);
  if (finished.includes(status)) return 'done';
  const at = board.columns.findIndex((column) => column.statuses.includes(status));
  return at <= 0 ? 'todo' : 'in_progress';
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const lookup = (pairs: Pair[] | undefined, jira: string): string | undefined => pairs?.find((pair) => same(pair.jira, jira))?.eidos;

// The Backlog type an issue type goes to, or null when it is not carried (REQ11).
export function typeFor(mapping: Mapping, board: BoardSettings, jiraType: string): string | null {
  if (mapping.types === undefined) return board.types.some((type) => same(type.name, jiraType)) ? board.types.find((type) => same(type.name, jiraType))!.name : DEFAULT_TYPE;
  return lookup(mapping.types, jiraType) ?? null;
}

// The Backlog status a Jira status goes to: the mapping's, else the same
// name, else the first status the Backlog files under its category (REQ11).
export function statusFor(mapping: Mapping, board: BoardSettings, jiraStatus: string, category: StatusCategory): string {
  const named = lookup(mapping.statuses, jiraStatus);
  if (named) return named;
  const byName = board.statuses.find((status) => same(status, jiraStatus));
  if (byName) return byName;
  return board.statuses.find((status) => backlogCategory(board, status) === category) ?? board.default_status;
}

// A Jira priority the mapping does not name goes to the Backlog priority of its name, else, given Jira's priorities in
// their order, to the one at its rank, as a draft proposes (both lists run from the highest, the Backlog's lowest past
// its last), so a connection with no priorities part never drops what a draft would have carried.
export function priorityFor(mapping: Mapping, board: BoardSettings, jiraPriority: string, jiraPriorities: string[] = []): string | null {
  const named = lookup(mapping.priorities, jiraPriority);
  if (named) return named;
  if (mapping.priorities !== undefined) return null;
  const byName = board.priorities.find((priority) => same(priority, jiraPriority));
  if (byName) return byName;
  const rank = jiraPriorities.findIndex((priority) => same(priority, jiraPriority));
  if (rank < 0 || board.priorities.length === 0) return null;
  return board.priorities[Math.min(rank, board.priorities.length - 1)] ?? null;
}

// Which side owns a field pair (Jira Sync REQ2): `pull` for one Jira owns, `push` for one the root owns, `both` else.
export function syncOf(pair: Pair): 'both' | 'pull' | 'push' {
  if (pair.owner === 'jira') return 'pull';
  if (pair.owner === 'eidos') return 'push';
  return 'both';
}

export function linkTypeFor(mapping: Mapping, board: BoardSettings, jiraLink: string): string | null {
  const named = lookup(mapping.link_types, jiraLink);
  if (named) return named;
  if (mapping.link_types !== undefined) return null;
  return board.link_types.find((type) => same(type.name, jiraLink) || same(type.outward, jiraLink))?.name ?? null;
}

// ---- the checks -------------------------------------------------------------------

export interface MappingProblem {
  code: 'pair-type' | 'option-missing' | 'direction' | 'target-unknown';
  message: string;
}

export type Kind = 'text' | 'doc' | 'number' | 'date' | 'option' | 'options' | 'user' | 'users' | 'sprint' | 'parent' | 'status' | 'priority' | 'any';

const SPRINT = 'com.pyxis.greenhopper.jira:gh-sprint';
const RICH = ['com.atlassian.jira.plugin.system.customfieldtypes:textarea'];
// Jira REQ10: what Jira sets and never takes
export const READ_ONLY = ['key', 'creator', 'reporter', 'created', 'updated', 'resolutiondate'];

// A field the description may not list (it reads the create screen's fields), as every board has it.
const SYSTEM: Record<string, Kind> = {
  summary: 'text',
  description: 'doc',
  environment: 'doc',
  status: 'status',
  priority: 'priority',
  assignee: 'user',
  reporter: 'user',
  creator: 'user',
  parent: 'parent',
  labels: 'options',
  components: 'options',
  fixVersions: 'options',
  versions: 'options',
  duedate: 'date',
  created: 'date',
  updated: 'date',
  resolutiondate: 'date',
  key: 'text',
};

export function kindOf(field: JiraField | undefined, id: string): Kind {
  if (!field) return SYSTEM[id] ?? 'any';
  if (field.custom === SPRINT) return 'sprint';
  if (field.system && SYSTEM[field.system]) return SYSTEM[field.system]!;
  if (field.custom && RICH.includes(field.custom)) return 'doc';
  switch (field.type) {
    case 'string':
      return 'text';
    case 'number':
      return 'number';
    case 'date':
    case 'datetime':
      return 'date';
    case 'option':
    case 'version':
    case 'priority':
    case 'issuetype':
    case 'resolution':
      return 'option';
    case 'user':
      return 'user';
    case 'array':
      return field.items === 'user' ? 'users' : 'options';
    default:
      return 'any';
  }
}

const TEXT_KINDS: Kind[] = ['text', 'doc', 'number', 'date', 'option', 'user', 'status', 'priority', 'any'];

// Jira REQ9: whether a Jira field of this kind can be carried into the Eidos side named, and why not.
function carries(kind: Kind, eidos: string, board: BoardSettings): string | null {
  const [head, name = ''] = eidos.split(/:(.*)/s);
  const want = (kinds: Kind[], what: string): string | null => (kinds.includes(kind) || kind === 'any' ? null : `a ${kind} field is not carried into ${what}`);
  switch (head) {
    case 'title':
      return want(['text'], 'the title');
    case 'status':
      return want(['status', 'option'], 'the status');
    case 'priority':
      return want(['priority', 'option'], 'the priority');
    case 'assignee':
      return want(['user', 'users'], 'the assignee');
    case 'milestone':
      return want(['sprint', 'option', 'text'], 'the milestone');
    case 'parent':
      return want(['parent'], 'the parent');
    case 'dependencies':
      return 'dependencies are retired for links; map Jira links with link_types';
    case 'section':
      return want(['text', 'doc'], `the section ${name}`);
    case 'property': {
      const property = board.properties.find((held) => same(held.name, name));
      if (!property) return null;
      const type = property.type.toLowerCase();
      if (property.options && property.options.length > 0 && type !== 'list') return want(['option', 'status', 'priority', 'text'], `the property ${property.name}`);
      if (type === 'number') return want(['number'], `the Number property ${property.name}`);
      if (type === 'date') return want(['date'], `the Date property ${property.name}`);
      if (type === 'list') return want(['options', 'users', 'option', 'sprint'], `the List property ${property.name}`);
      return want(TEXT_KINDS, `the ${property.type} property ${property.name}`);
    }
    default:
      return null;
  }
}

function targetKnown(eidos: string, board: BoardSettings): string | null {
  const [head, name = ''] = eidos.split(/:(.*)/s);
  if (['title', 'status', 'priority', 'assignee', 'milestone', 'parent', 'dependencies'].includes(eidos)) return null;
  if (head === 'property') return board.properties.some((held) => same(held.name, name)) ? null : `no task property '${name}' is declared (eidos backlog configure:property adds one)`;
  if (head === 'section') {
    const keys = new Set([...board.sections, ...board.types.flatMap((type) => type.sections)].map((section) => section.key));
    return keys.has(name) ? null : `no task section '${name}' is declared`;
  }
  return `'${eidos}' is none of a task's fields, property:<name>, or section:<key>`;
}

// Every problem a connection's mapping has against the Backlog and, when it has been read, Jira.
export function checkMapping(connection: Connection, board: BoardSettings, description: Description | null): MappingProblem[] {
  const out: MappingProblem[] = [];
  const at = (part: string, pair: Pair): string => `${connection.name}: ${part} ${pair.jira} → ${pair.eidos}`;
  const fields = description ? allFields(description) : [];
  for (const pair of connection.mapping.fields ?? []) {
    const unknown = targetKnown(pair.eidos, board);
    if (unknown) {
      out.push({ code: 'target-unknown', message: `${at('field', pair)}: ${unknown}` });
      continue;
    }
    if (connection.direction === 'push' && READ_ONLY.includes(pair.jira))
      out.push({ code: 'direction', message: `${at('field', pair)}: Jira sets ${pair.jira} and never takes it, so a push cannot carry it` });
    // a pair naming issue types is checked against those types' fields alone
    const named = description && pair.types?.length ? description.types.filter((type) => pair.types!.some((held) => same(held, type.name))) : [];
    const strange = description ? (pair.types ?? []).filter((held) => !description.types.some((type) => same(type.name, held))) : [];
    if (strange.length > 0) {
      out.push({ code: 'target-unknown', message: `${at('field', pair)}: the project has no issue type ${strange.join(', ')}` });
      continue;
    }
    const pool = named.length > 0 ? named.flatMap((type) => type.fields) : fields;
    const field = pool.find((held) => held.id === pair.jira || same(held.name, pair.jira));
    if (description && !field && !SYSTEM[pair.jira]) {
      const where = named.length > 0 ? `the issue type ${named.map((type) => type.name).join(', ')} has` : "the project's issue types have";
      out.push({ code: 'target-unknown', message: `${at('field', pair)}: ${where} no field ${pair.jira} (eidos jira describe ${connection.name} lists them)` });
      continue;
    }
    const why = carries(kindOf(field, pair.jira), pair.eidos, board);
    if (why) out.push({ code: 'pair-type', message: `${at('field', pair)}: ${why}; change the pair` });
    if (field?.allowed && pair.eidos.startsWith('property:')) {
      const property = board.properties.find((held) => same(held.name, pair.eidos.slice('property:'.length)));
      const missing = property?.options ? field.allowed.filter((value) => !property.options!.some((option) => same(option, value))) : [];
      if (missing.length > 0)
        out.push({ code: 'option-missing', message: `${at('field', pair)}: the property ${property!.name} declares no option ${missing.map((value) => `'${value}'`).join(', ')}; add the option` });
    }
  }
  for (const pair of connection.mapping.types ?? [])
    if (!board.types.some((type) => same(type.name, pair.eidos))) out.push({ code: 'target-unknown', message: `${at('type', pair)}: the Backlog has no task type ${pair.eidos}` });
  for (const pair of connection.mapping.statuses ?? [])
    if (!board.statuses.some((status) => same(status, pair.eidos))) out.push({ code: 'target-unknown', message: `${at('status', pair)}: the Backlog has no status ${pair.eidos}` });
  for (const pair of connection.mapping.priorities ?? [])
    if (!board.priorities.some((priority) => same(priority, pair.eidos))) out.push({ code: 'target-unknown', message: `${at('priority', pair)}: the Backlog has no priority ${pair.eidos}` });
  for (const pair of connection.mapping.link_types ?? [])
    if (!board.link_types.some((type) => same(type.name, pair.eidos))) out.push({ code: 'target-unknown', message: `${at('link type', pair)}: the Backlog has no link type ${pair.eidos}` });
  return out;
}

// ---- the draft --------------------------------------------------------------------

export interface DraftEntry {
  part: MappingPart;
  jira: string;
  eidos: string;
  why: string;
}

// Jira REQ12, without the AI Agent: a mapping drafted by matching names,
// categories, and a priority's rank, each entry one the person accepts or
// rejects. An entry the mapping already holds is not proposed again.
export function draftMapping(connection: Connection, board: BoardSettings, description: Description): { entries: DraftEntry[]; unmatched: string[] } {
  const entries: DraftEntry[] = [];
  const unmatched: string[] = [];
  const held = (part: DraftEntry['part'], jira: string): boolean => (connection.mapping[part] ?? []).some((pair) => same(pair.jira, jira));
  for (const type of description.types) {
    if (held('types', type.name)) continue;
    const match = board.types.find((candidate) => same(candidate.name, type.name) || same(candidate.title, type.name));
    if (match) entries.push({ part: 'types', jira: type.name, eidos: match.name, why: 'same name' });
    else if (!type.subtask) entries.push({ part: 'types', jira: type.name, eidos: DEFAULT_TYPE, why: 'no type of that name; the default type' });
    else entries.push({ part: 'types', jira: type.name, eidos: DEFAULT_TYPE, why: 'a sub-task type; the default type, each filed by the parent rule' });
  }
  for (const status of allStatuses(description)) {
    if (held('statuses', status.name)) continue;
    const match = board.statuses.find((candidate) => same(candidate, status.name));
    if (match) entries.push({ part: 'statuses', jira: status.name, eidos: match, why: 'same name' });
    else {
      const byCategory = board.statuses.find((candidate) => backlogCategory(board, candidate) === status.category);
      if (byCategory) entries.push({ part: 'statuses', jira: status.name, eidos: byCategory, why: `same category (${status.category})` });
      else unmatched.push(`status ${status.name}: no Backlog status in its category`);
    }
  }
  // a priority with no Backlog priority of its name takes the one at its rank, both lists running from the highest, the
  // lowest for a Jira priority past the Backlog's last
  description.priorities.forEach((priority, rank) => {
    if (held('priorities', priority)) return;
    const match = board.priorities.find((candidate) => same(candidate, priority));
    if (match) entries.push({ part: 'priorities', jira: priority, eidos: match, why: 'same name' });
    else if (board.priorities.length > 0) {
      const byRank = board.priorities[Math.min(rank, board.priorities.length - 1)]!;
      entries.push({ part: 'priorities', jira: priority, eidos: byRank, why: `by rank (${rank + 1} of ${description.priorities.length})` });
    } else unmatched.push(`priority ${priority}: the Backlog has no priorities`);
  });
  for (const type of description.link_types) {
    if (held('link_types', type.name)) continue;
    const match = board.link_types.find((candidate) => same(candidate.name, type.name) || same(candidate.outward, type.outward));
    if (match) entries.push({ part: 'link_types', jira: type.name, eidos: match.name, why: match.name.toLowerCase() === type.name.toLowerCase() ? 'same name' : 'same phrase' });
    else unmatched.push(`link type ${type.name}: no Backlog link type of that name or phrase`);
  }
  // Fields: the defaults every board has, then a sprint field to the milestone, labels to a List property of that name, and a
  // custom field to a property of the same name whose type holds it
  if (connection.mapping.fields === undefined) {
    for (const pair of defaultFields(board)) entries.push({ part: 'fields', ...pair, why: 'every board has it' });
    if (description.sprint_field) entries.push({ part: 'fields', jira: description.sprint_field, eidos: 'milestone', why: "the board's sprints, each a milestone" });
    const labels = board.properties.find((property) => ['labels', 'tags'].includes(property.name.toLowerCase()) && property.type.toLowerCase() === 'list');
    if (labels) entries.push({ part: 'fields', jira: 'labels', eidos: `property:${labels.name}`, why: 'a List property of that name' });
    for (const field of allFields(description)) {
      if (!field.id.startsWith('customfield_') || field.custom === SPRINT) continue;
      const property = board.properties.find((candidate) => same(candidate.name, field.name));
      if (property && carries(kindOf(field, field.id), `property:${property.name}`, board) === null)
        entries.push({ part: 'fields', jira: field.id, eidos: `property:${property.name}`, why: `a property named ${field.name}` });
    }
  }
  return { entries, unmatched };
}

// ---- the editor -------------------------------------------------------------------

// Fields the editor leaves out: what says where an issue sits rather than what it holds, and links, mapped by link_types.
const STRUCTURAL = ['issuetype', 'project', 'issuelinks', 'attachment'];

export interface EditorField {
  id: string;
  name: string;
  kind: Kind;
  // every Eidos side this field can be carried into, as the checks read one
  targets: string[];
  // the property a field with no fitting one would take, when the person makes it
  property: { type: string; options?: string[] };
}

export interface EditorModel {
  connection: string;
  read: string;
  types: Array<{ name: string; subtask: boolean; statuses: string[]; fields: EditorField[] }>;
  statuses: Array<{ name: string; category: StatusCategory }>;
  priorities: string[];
  link_types: string[];
  backlog: { types: string[]; statuses: string[]; priorities: string[]; link_types: string[]; properties: Array<{ name: string; type: string }> };
  // the mapping as held, and a whole one drafted from names and categories, the page showing a held pair before a drafted one
  mapping: Mapping;
  suggested: Mapping;
  // where the editor starts: the held pair, else what a pull does with a value the mapping leaves out
  chosen: MappingChoice;
}

export const PARENT_RULES: ParentRule[] = ['subtasks', 'all', 'none'];

// What the editor saves: a Backlog value for every Jira one (empty where it is not carried), and each field's place per
// issue type.
export interface MappingChoice {
  types: Record<string, string>;
  statuses: Record<string, string>;
  priorities: Record<string, string>;
  link_types: Record<string, string>;
  fields: Array<{ type: string; jira: string; eidos: string }>;
  parent: ParentRule;
}

function targetsOf(kind: Kind, board: BoardSettings): string[] {
  const sections = [...new Set([...board.sections, ...board.types.flatMap((type) => type.sections)].filter((section) => section.type === 'text').map((section) => `section:${section.key}`))];
  const all = ['title', 'status', 'priority', 'assignee', 'milestone', 'parent', ...sections, ...board.properties.map((property) => `property:${property.name}`)];
  return all.filter((eidos) => carries(kind, eidos, board) === null);
}

function propertyFor(kind: Kind, field: JiraField | undefined): EditorField['property'] {
  const options = field?.allowed;
  if (kind === 'number') return { type: 'Number' };
  if (kind === 'date') return { type: field?.type === 'datetime' ? 'Date & time' : 'Date' };
  if (kind === 'options' || kind === 'users' || kind === 'sprint') return { type: 'List', ...(options ? { options } : {}) };
  return { type: 'Text', ...(options && kind === 'option' ? { options } : {}) };
}

// Jira REQ12: every value Jira holds with the Backlog values it can go to, the mapping held, and a draft of all of it.
export function editorModel(connection: Connection, board: BoardSettings, description: Description): EditorModel {
  const field = (held: JiraField | undefined, id: string, name: string): EditorField => {
    const kind = kindOf(held, id);
    return { id, name, kind, targets: targetsOf(kind, board), property: propertyFor(kind, held) };
  };
  const drafted = draftMapping({ ...connection, mapping: {} }, board, description).entries;
  const suggested: Mapping = {};
  for (const entry of drafted) suggested[entry.part] = [...(suggested[entry.part] ?? []), { jira: entry.jira, eidos: entry.eidos }];
  const held = connection.mapping;
  // a value the held part leaves out is not carried, but a status, which a pull files by its category all the same
  const start = (part: Exclude<MappingPart, 'fields'>, names: string[], leftOutSuggested: boolean): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const jira of names) {
      const own = lookup(held[part], jira);
      const suggestion = lookup(suggested[part], jira) ?? '';
      if (own) out[jira] = own;
      else if (held[part] === undefined || leftOutSuggested) out[jira] = suggestion;
      else out[jira] = '';
    }
    return out;
  };
  const pairs = held.fields ?? suggested.fields ?? [];
  const chosen: MappingChoice = {
    types: start(
      'types',
      description.types.map((type) => type.name),
      false,
    ),
    statuses: start(
      'statuses',
      allStatuses(description).map((status) => status.name),
      true,
    ),
    priorities: start('priorities', description.priorities, false),
    link_types: start(
      'link_types',
      description.link_types.map((type) => type.name),
      false,
    ),
    fields: description.types.flatMap((type) => fieldsFor(pairs, type.name).map((pair) => ({ type: type.name, jira: pair.jira, eidos: pair.eidos }))),
    parent: held.parent ?? 'subtasks',
  };
  return {
    connection: connection.name,
    read: description.read,
    types: description.types.map((type) => ({
      name: type.name,
      subtask: type.subtask,
      statuses: type.statuses.map((status) => status.name),
      // status is never on a create screen, and every issue has one
      fields: [field(undefined, 'status', 'Status'), ...type.fields.filter((held) => held.id && !STRUCTURAL.includes(held.id)).map((held) => field(held, held.id, held.name))],
    })),
    statuses: allStatuses(description).map((status) => ({ name: status.name, category: status.category })),
    priorities: description.priorities,
    link_types: description.link_types.map((type) => type.name),
    backlog: {
      types: board.types.map((type) => type.name),
      statuses: board.statuses,
      priorities: board.priorities,
      link_types: board.link_types.map((type) => type.name),
      properties: board.properties.map((property) => ({ name: property.name, type: property.type })),
    },
    mapping: connection.mapping,
    suggested,
    chosen,
  };
}

// The field pairs a choice per issue type comes to: one pair for a field every type holding it carries to the same
// place, else a pair per place naming its types. A held pair for a field the editor did not show is kept as it was.
export function compactFields(chosen: Array<{ type: string; jira: string; eidos: string }>, model: EditorModel, held: Pair[]): Pair[] {
  const shown = new Set(model.types.flatMap((type) => type.fields.map((one) => one.id)));
  const out: Pair[] = held.filter((pair) => !shown.has(pair.jira));
  for (const jira of [...new Set(chosen.map((choice) => choice.jira))]) {
    const holding = model.types.filter((type) => type.fields.some((one) => one.id === jira)).map((type) => type.name);
    const picks = chosen.filter((choice) => choice.jira === jira);
    const places = [...new Set(picks.map((choice) => choice.eidos))];
    const everyType = holding.every((type) => picks.some((choice) => same(choice.type, type)));
    if (places.length === 1 && everyType) {
      out.push({ jira, eidos: places[0]! });
      continue;
    }
    for (const eidos of places) out.push({ jira, eidos, types: picks.filter((choice) => choice.eidos === eidos).map((choice) => choice.type) });
  }
  return out;
}
