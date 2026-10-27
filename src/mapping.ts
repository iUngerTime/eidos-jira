// A connection's mapping as a pull applies it, and its checks (Jira REQ7 to
// REQ13). Every part is optional: a part the mapping leaves out carries by
// name (every issue type into the Backlog's default type, every status by its
// category, a priority or a link type of the same name), and a part it gives
// carries only what it names. `fields` left out carries what every board has
// (REQ8). A pair is checked against the Jira field's schema and the Backlog's
// declarations (REQ9) and against the connection's direction (REQ10).
import { allFields, allStatuses, type Description, type JiraField } from './describe.ts';
import type { Connection, Mapping, Pair } from './connections.ts';
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

export function priorityFor(mapping: Mapping, board: BoardSettings, jiraPriority: string): string | null {
  const named = lookup(mapping.priorities, jiraPriority);
  if (named) return named;
  if (mapping.priorities !== undefined) return null;
  return board.priorities.find((priority) => same(priority, jiraPriority)) ?? null;
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

type Kind = 'text' | 'doc' | 'number' | 'date' | 'option' | 'options' | 'user' | 'users' | 'sprint' | 'parent' | 'status' | 'priority' | 'any';

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
    const field = fields.find((held) => held.id === pair.jira || same(held.name, pair.jira));
    if (description && !field && !SYSTEM[pair.jira]) {
      out.push({ code: 'target-unknown', message: `${at('field', pair)}: the project's issue types have no field ${pair.jira} (eidos jira describe ${connection.name} lists them)` });
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
  part: keyof Omit<Mapping, 'parent'>;
  jira: string;
  eidos: string;
  why: string;
}

// Jira REQ12, without the AI Agent: a mapping drafted by matching names and
// categories, each entry one the person accepts or rejects. An entry the
// mapping already holds is not proposed again.
export function draftMapping(connection: Connection, board: BoardSettings, description: Description): { entries: DraftEntry[]; unmatched: string[] } {
  const entries: DraftEntry[] = [];
  const unmatched: string[] = [];
  const held = (part: DraftEntry['part'], jira: string): boolean => (connection.mapping[part] ?? []).some((pair) => same(pair.jira, jira));
  for (const type of description.types) {
    if (held('types', type.name)) continue;
    const match = board.types.find((candidate) => same(candidate.name, type.name) || same(candidate.title, type.name));
    if (match) entries.push({ part: 'types', jira: type.name, eidos: match.name, why: 'same name' });
    else if (!type.subtask) entries.push({ part: 'types', jira: type.name, eidos: DEFAULT_TYPE, why: 'no type of that name; the default type' });
    else unmatched.push(`issue type ${type.name} (a sub-task type): no Backlog type of that name`);
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
  for (const priority of description.priorities) {
    if (held('priorities', priority)) continue;
    const match = board.priorities.find((candidate) => same(candidate, priority));
    if (match) entries.push({ part: 'priorities', jira: priority, eidos: match, why: 'same name' });
    else unmatched.push(`priority ${priority}: no Backlog priority of that name`);
  }
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
