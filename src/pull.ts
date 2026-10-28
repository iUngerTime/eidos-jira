// Jira Pull: a fetch reads what changed in a connection's scope since its
// last pull and says what a pull would do, writing nothing to the root; a
// pull does it (Jira Pull REQ1 to REQ11, REQ14 to REQ16). Jira wins on every
// field the mapping carries; what the mapping leaves alone is never touched.
// Each issue's task holds its issue under its `jira` key, with what the pull
// wrote as a digest per field, so an edit made in the root is told from a
// change in Jira on any machine. Only the last pull's time is per machine.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Host } from 'eidosmd/plugin';
import { adfToMarkdown, type AdfContext } from './adf.ts';
import { siteBase, type Requester } from './client.ts';
import { siteKey, type Connection, type Pair } from './connections.ts';
import { cachedDescription, categoryOf } from './describe.ts';
import { bundlesOf, checklistFromJira, partPairs, realField as realFieldOf, sectionOf, splitIssue } from './bundle.ts';
import { DEFAULT_TYPE, fieldsFor, fieldsOf, linkTypeFor, priorityFor, statusFor, typeFor } from './mapping.ts';
import type { AssetsApi, BacklogApi, BoardSettings, CommentsApi, TaskFields, TaskView, ThreadView } from './types.ts';

// ---- what Jira gives -----------------------------------------------------------------

export interface JiraUser {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
}

interface JiraComment {
  id: string;
  author?: JiraUser;
  body?: unknown;
  created: string;
  updated?: string;
  visibility?: { type: string; value: string };
}

interface JiraAttachment {
  id: string;
  filename: string;
  content: string;
}

interface IssueLink {
  type: { name: string };
  outwardIssue?: { id: string; key: string };
  inwardIssue?: { id: string; key: string };
}

export interface Issue {
  id: string;
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    issuetype?: { name: string; subtask?: boolean };
    status?: { name: string; statusCategory?: { key?: string } };
    priority?: { name: string } | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    parent?: { id: string; key: string } | null;
    issuelinks?: IssueLink[];
    comment?: { comments?: JiraComment[]; total?: number };
    attachment?: JiraAttachment[];
    created?: string;
    updated?: string;
  };
}

// What a task holds of its issue (Jira REQ14), under its `jira` key.
export interface Held {
  site: string;
  id: string;
  key: string;
  updated?: string;
  comments?: string;
  parent?: string;
  digest?: Record<string, string>;
  // what Jira itself held for each mapped field at the last pull or sync, hashed before the mapping reads it (a status's id,
  // an option's id, a document with its local ids taken out), so a change in Jira that the mapping folds away is still seen
  remote?: Record<string, string>;
  gone?: string;
  // the connection that created the issue from this task, and the mark a create leaves before Jira answers (Jira Push)
  connection?: string;
  pending?: string;
  since?: string;
}

// ---- the plan ---------------------------------------------------------------------

export interface Plan {
  connection: string;
  since: string | null;
  add: Array<{ key: string; title: string; type: string }>;
  change: Array<{ key: string; task: string; fields: string[] }>;
  // tasks whose mapped fields were edited in the root since their last pull, and those fields (REQ5)
  local: Array<{ key: string; task: string; fields: string[] }>;
  // tasks whose fields the root owns that Jira changed, left as the root has them for a sync to settle
  owned: Array<{ key: string; task: string; fields: string[] }>;
  // issues a cut-short create made, left for that task's next create to link
  waiting: Array<{ key: string; task: string }>;
  // issues whose task is marked Don't sync, left as the root has them
  skipped: Array<{ key: string; task: string }>;
  comments: { add: number; change: number; remove: number };
  // the people a pull adds to the root's users, with `add_people` on
  people: string[];
  gone: Array<{ key: string; task: string }>;
  back: Array<{ key: string; task: string }>;
  left_out: { types: Record<string, number>; links: number; parents: number };
  attachments: number;
  // the sprints a pull adds as milestones, the Backlog declaring none of that name
  milestones: string[];
  unchanged: number;
}

export interface Done {
  connection: string;
  added: number;
  changed: number;
  kept_local: number;
  comments: { added: number; changed: number; removed: number };
  people: number;
  gone: number;
  attachments: number;
  left_out: Plan['left_out'];
}

export interface PullOptions {
  full?: boolean;
  keepLocal?: boolean;
  // the moment the run reads Jira, for a test's clock
  now?: Date;
}

// ---- the per-machine state ----------------------------------------------------------

export interface State {
  last_pull?: string;
  last_fetch?: { at: string; count: number; error?: string };
}

const stateFile = (workspace: string, name: string): string => path.join(workspace, 'local', `state-${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}.json`);

export function readState(workspace: string, name: string): State {
  const file = stateFile(workspace, name);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as State;
  } catch {
    return {};
  }
}

export function writeState(workspace: string, name: string, state: State): void {
  const file = stateFile(workspace, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

// Jira REQ3's overlap: the search asks for a few minutes before the last pull, since Jira's search is eventually consistent and its JQL counts minutes.
export const OVERLAP_MINUTES = 5;

// ---- reading Jira ---------------------------------------------------------------------

const BASE_FIELDS = ['summary', 'description', 'status', 'priority', 'assignee', 'reporter', 'parent', 'issuetype', 'issuelinks', 'comment', 'attachment', 'created', 'updated'];

// The connection's scope as JQL: the board's filter (its ORDER BY taken off), else the project, then the connection's own jql.
export async function scopeJql(client: Requester, connection: Connection): Promise<string> {
  let scope = `project = "${connection.project}"`;
  if (connection.board !== undefined) {
    const configuration = await client.get<{ filter?: { id?: string } }>(`/rest/agile/1.0/board/${connection.board}/configuration`);
    const id = configuration.filter?.id;
    if (id) {
      const jql = (await client.get<{ jql?: string }>(`/rest/api/3/filter/${id}`)).jql;
      if (jql?.trim()) scope = jql.replace(/\s+ORDER\s+BY\s+.*$/is, '').trim();
    }
  }
  return connection.jql ? `(${scope}) AND (${connection.jql})` : scope;
}

// A moment as the JQL of a person in a time zone writes it: `yyyy-MM-dd HH:mm`.
export function jqlMoment(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}`;
}

async function search(client: Requester, jql: string, fields: string[], max: number): Promise<Issue[]> {
  const out: Issue[] = [];
  let nextPageToken: string | undefined;
  for (;;) {
    const page = await client.post<{ issues?: Issue[]; nextPageToken?: string; isLast?: boolean }>('/rest/api/3/search/jql', {
      jql,
      fields,
      maxResults: max,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    out.push(...(page.issues ?? []));
    if (!page.nextPageToken || page.isLast === true) return out;
    nextPageToken = page.nextPageToken;
  }
}

async function allComments(client: Requester, issue: Issue): Promise<JiraComment[]> {
  const held = issue.fields.comment;
  if (held?.comments && (held.total === undefined || held.comments.length >= held.total)) return held.comments;
  const out: JiraComment[] = [];
  for (let startAt = 0; ;) {
    const page = await client.get<{ comments?: JiraComment[]; total?: number }>(`/rest/api/3/issue/${issue.id}/comment`, { startAt, maxResults: 100, orderBy: 'created' });
    out.push(...(page.comments ?? []));
    if ((page.comments ?? []).length === 0 || out.length >= (page.total ?? 0)) return out;
    startAt = out.length;
  }
}

// ---- values ---------------------------------------------------------------------------

// A Jira time as a task's dates write one: to the second, with its offset.
export function moment(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const zone = match[2] === 'Z' ? '+00:00' : match[2]!.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  return `${match[1]}${zone}`;
}

export const short = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 8);

const named = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null) {
    const held = value as Record<string, unknown>;
    for (const key of ['name', 'value', 'displayName', 'key']) if (typeof held[key] === 'string') return held[key] as string;
  }
  return null;
};

// Jira's own value for one field, as the remote base hashes it: an object by its id (a status, a priority, an option, a
// person by their account), a list in Jira's order, and a document without the local ids an editor stamps on its nodes.
export function rawOf(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) return value.length === 0 ? null : value.map(rawOf);
  if (typeof value !== 'object') return value;
  const held = value as Record<string, unknown>;
  if (held['type'] === 'doc' || Array.isArray(held['content'])) return stripLocal(held);
  for (const key of ['accountId', 'id', 'value', 'name', 'key']) if (typeof held[key] === 'string' || typeof held[key] === 'number') return { [key]: held[key] };
  return value;
}

function stripLocal(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripLocal);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'localId') continue;
    out[key] = stripLocal(value);
  }
  return out;
}

// The remote base of one pair: Jira's own value of its field (the parent by its issue id).
export function remoteOf(issue: Issue, pair: Pair): string {
  if (pair.eidos === 'parent') return short(issue.fields.parent?.id ?? null);
  return short(rawOf(issue.fields[pair.jira]));
}

// The latest of an issue's sprints: the active one, else the last listed.
function latestSprint(value: unknown): { name: string; end: string | null } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const sprints = value.filter((sprint): sprint is Record<string, unknown> => typeof sprint === 'object' && sprint !== null && typeof sprint['name'] === 'string');
  const chosen = sprints.find((sprint) => sprint['state'] === 'active') ?? sprints[sprints.length - 1];
  if (!chosen) return null;
  const end = typeof chosen['completeDate'] === 'string' ? chosen['completeDate'] : typeof chosen['endDate'] === 'string' ? chosen['endDate'] : null;
  return { name: chosen['name'] as string, end: end ? end.slice(0, 10) : null };
}

// What a task holds now for one Eidos side of a pair, as the digest reads it.
export function heldValue(task: TaskView, eidos: string): unknown {
  const [head, name = ''] = eidos.split(/:(.*)/s);
  switch (head) {
    case 'title':
      return task.title;
    case 'type':
      return task.type;
    case 'status':
      return task.status;
    case 'priority':
      return task.priority;
    case 'assignee':
      return [...task.assignee].sort();
    case 'milestone':
      return task.milestone;
    case 'parent':
      return task.parent;
    case 'section':
      return (task.sections.find((section) => section.key === name)?.text ?? '').trim();
    case 'property':
      return task.properties[name] ?? null;
    default:
      return null;
  }
}

// A task marked Don't sync stays the root's own: no pull writes it, no sync or create sends it, wherever its issue is.
export const skipOf = (task: TaskView): boolean => (task.properties['jira'] as { skip?: unknown } | null | undefined)?.skip === true;

export const heldOf = (task: TaskView): Held | null => {
  const value = task.properties['jira'];
  if (typeof value !== 'object' || value === null) return null;
  const held = value as Record<string, unknown>;
  return typeof held['id'] === 'string' && typeof held['site'] === 'string' && typeof held['key'] === 'string' ? (held as unknown as Held) : null;
};

const projectOf = (key: string): string => key.replace(/-\d+$/, '').toUpperCase();

// Jira's priorities from the highest, for a priority the mapping leaves to its rank: the description's, else read once.
export async function prioritiesOf(context: Pick<Context, 'host' | 'client' | 'connection'>): Promise<string[]> {
  if (context.connection.mapping.priorities !== undefined) return [];
  const held = cachedDescription(context.host.workspace, context.connection.name);
  if (held) return held.priorities;
  const page = await context.client.get<{ values?: Array<{ name: string }> }>('/rest/api/3/priority/search', { maxResults: 100 }).catch(() => null);
  return (page?.values ?? []).map((priority) => priority.name);
}

// ---- the run -----------------------------------------------------------------------

export interface Context {
  host: Host;
  backlog: BacklogApi;
  comments: CommentsApi | undefined;
  assets: AssetsApi | undefined;
  client: Requester;
  connection: Connection;
  timeZone: string;
  pullAttachments: boolean;
  // `add_people`: a person the root does not have is added to its users
  addPeople: boolean;
  // the Jira account the token signs in as, whose root user's messages a sync may send
  me?: JiraUser;
}

// One issue as the pull would write it.
interface Intent {
  issue: Issue;
  task: TaskView | null;
  type: string;
  fields: TaskFields;
  // the digest per Eidos side, of the values the fields set
  digest: Record<string, string>;
  // Jira's own value per Eidos side
  remote: Record<string, string>;
  // the Eidos sides whose value changes
  changes: string[];
  // the Eidos sides edited in the root since the last pull
  local: string[];
  // the sides the root owns (a pair's `owner: eidos`) that Jira holds otherwise; a pull leaves them, a sync settles them
  owned: string[];
  parentIssue: string | null;
  parentKey: string | null;
  comments: JiraComment[] | null;
  // the sections of a bundled field whose heading Jira's text lacks, which the pull leaves as the root has them (Jira REQ21)
  absent: Set<string>;
}

// A Jira person as the root writes them (Jira REQ15): the root user of the
// same name or alias where there is one, else, with `add_people` on, a person
// added to the root's users under that name, else the name Jira gives them.
interface Person {
  name: string;
  // the root user they are, when one has their name
  user: string | null;
}

export interface People {
  of(user: { displayName?: string; accountId?: string; emailAddress?: string | null } | null | undefined): Person | null;
  // the people a pull added, or a fetch would add, by name
  added: Set<string>;
}

export function peopleFor(context: Context, write: boolean): People {
  const added = new Set<string>();
  const of: People['of'] = (user) => {
    if (!user?.accountId && !user?.displayName) return null;
    const name = user.displayName?.trim() || 'Jira';
    // the mapping's users first: a Jira person named by their account, email, or name, as the root user they are
    const listed = context.connection.mapping.users?.find((pair) =>
      [user.accountId, user.emailAddress ?? undefined, user.displayName].some((held) => held !== undefined && held.trim().toLowerCase() === pair.jira.trim().toLowerCase()),
    );
    const found = (listed ? context.comments?.authorAs(listed.eidos) : null) ?? context.comments?.authorAs(name) ?? null;
    if (found?.user) return { name, user: found.user };
    if (!context.addPeople || !user.accountId) return { name, user: null };
    added.add(name);
    // a fetch adds nobody, but a task or a comment that names someone a pull would add changes with them: their stand-in
    // alias differs from the name written now, so it is counted, and is never written
    if (!write) return { name, user: `\u0000${name}` };
    const person = context.host.addPerson({ name, email: user.emailAddress ?? null });
    return { name, user: person.user.alias ?? person.user.name };
  };
  return { of, added };
}

export async function run(context: Context, write: boolean, options: PullOptions = {}): Promise<{ plan: Plan; done: Done | null }> {
  const { host, backlog, client, connection } = context;
  const now = options.now ?? new Date();
  const state = readState(host.workspace, connection.name);
  const board = backlog.settings();
  const pairs = fieldsOf(connection, board);
  const scope = await scopeJql(client, connection);
  const since = options.full || !state.last_pull ? null : new Date(new Date(state.last_pull).getTime() - OVERLAP_MINUTES * 60_000);
  const changedJql = since ? `(${scope}) AND updated >= "${jqlMoment(since, context.timeZone)}"` : scope;
  const wanted = [...new Set([...BASE_FIELDS, ...pairs.map((pair) => pair.jira)])];
  const issues = await search(client, `${changedJql} ORDER BY key ASC`, wanted, 100);
  const inScope = new Set((await search(client, scope, ['id'], 5000)).map((issue) => issue.id));
  const site = siteKey(connection.site);
  const base = siteBase(connection.site);
  const jiraPriorities = await prioritiesOf(context);

  const tasks = (): TaskView[] => backlog.tasks();
  const byIssue = (): Map<string, TaskView> => {
    const out = new Map<string, TaskView>();
    for (const task of tasks()) {
      const held = heldOf(task);
      if (held && siteKey(held.site) === site && !out.has(held.id)) out.set(held.id, task);
    }
    return out;
  };
  const held = byIssue();
  // tasks whose create was cut short: an issue carrying one's mark is that task's, never a second task (Jira Push REQ9)
  const pendingMarks = new Map<string, string>();
  for (const task of tasks()) {
    const mark = task.properties['jira'] as { site?: unknown; pending?: unknown } | null | undefined;
    if (typeof mark?.pending === 'string' && typeof mark.site === 'string' && siteKey(mark.site) === site) pendingMarks.set(mark.pending, task.id ?? task.name);
  }
  // REQ11: a task marked gone whose issue is in the scope again is read with what changed, though Jira may not have
  // changed it, so it comes back; read by id, a hundred at a time
  const pulledIds = new Set(issues.map((issue) => issue.id));
  const returning = [...held].filter(([id, task]) => inScope.has(id) && !pulledIds.has(id) && heldOf(task)!.gone !== undefined).map(([id]) => id);
  for (let at = 0; at < returning.length; at += 100) issues.push(...(await search(client, `id in (${returning.slice(at, at + 100).join(', ')})`, wanted, 100)));

  const plan: Plan = {
    connection: connection.name,
    since: since ? since.toISOString() : null,
    add: [],
    change: [],
    local: [],
    owned: [],
    waiting: [],
    skipped: [],
    comments: { add: 0, change: 0, remove: 0 },
    people: [],
    gone: [],
    back: [],
    left_out: { types: {}, links: 0, parents: 0 },
    attachments: 0,
    milestones: [],
    unchanged: 0,
  };
  const sprints = new Map<string, string | null>();

  // parents before their sub-tasks, then by the key's number, so the same Jira state is written the same way
  const number = (key: string): number => Number(/-(\d+)$/.exec(key)?.[1] ?? 0);
  issues.sort(
    (a, b) => Number(a.fields.issuetype?.subtask === true) - Number(b.fields.issuetype?.subtask === true) || projectOf(a.key).localeCompare(projectOf(b.key)) || number(a.key) - number(b.key),
  );
  const carried = new Set<string>();
  for (const issue of issues) if (typeFor(connection.mapping, board, issue.fields.issuetype?.name ?? '') !== null) carried.add(issue.id);
  // an issue pulled before, still in scope, counts as pulled for its parent and its links
  for (const id of held.keys()) if (inScope.has(id)) carried.add(id);

  // a mention as the root user of that name, else as Jira writes it
  const people = peopleFor(context, write);
  const mention = (account: string, name: string): string | null => people.of({ accountId: account, displayName: name })?.user ?? null;

  const intents: Intent[] = [];
  for (const issue of issues) {
    const jiraType = issue.fields.issuetype?.name ?? '';
    const type = typeFor(connection.mapping, board, jiraType);
    if (type === null) {
      plan.left_out.types[jiraType] = (plan.left_out.types[jiraType] ?? 0) + 1;
      continue;
    }
    const task = held.get(issue.id) ?? null;
    if (task && skipOf(task)) {
      plan.skipped.push({ key: issue.key, task: task.id ?? task.name });
      continue;
    }
    const was = task ? heldOf(task) : null;
    const updated = moment(issue.fields.updated);
    if (task && was && !options.full && was.updated === updated && was.gone === undefined) {
      plan.unchanged += 1;
      continue;
    }
    if (!task && pendingMarks.size > 0) {
      const property = await client.get<{ value?: { pending?: string } }>(`/rest/api/3/issue/${issue.id}/properties/eidos`).catch(() => null);
      const waiting = property?.value?.pending ? pendingMarks.get(property.value.pending) : undefined;
      if (waiting) {
        plan.waiting.push({ key: issue.key, task: waiting });
        continue;
      }
    }
    const media = attachmentsFor(context, issue, task);
    const adf: AdfContext = { mention, media: media.link };
    const digest: Record<string, string> = { type: short(type) };
    // a field several sections are mapped to is read as one part per section (Jira REQ21)
    const typePairs = fieldsFor(pairs, issue.fields.issuetype?.name ?? '');
    const bundles = bundlesOf(typePairs);
    const issuePairs = partPairs(typePairs, bundles);
    const { issue: seen, absent } = splitIssue(issue, bundles, board);
    const intended = intendFields(connection, board, seen, type, issuePairs, people, adf, carried, jiraPriorities);
    const { fields, parentIssue, parentKey } = intended;
    if (intended.sprint) sprints.set(intended.sprint.name, intended.sprint.end);
    if (intended.parentLeftOut) plan.left_out.parents += 1;
    const remote: Record<string, string> = Object.fromEntries(issuePairs.map((pair) => [pair.eidos, remoteOf(seen, pair)]));
    for (const pair of issuePairs) if (pair.eidos !== 'parent') digest[pair.eidos] = short(normalise(intendedValue(fields, pair.eidos)));
    // a section Jira's text holds no heading for keeps what was recorded of it, so a sync still sends it
    for (const side of absent) {
      if (was?.digest?.[side] !== undefined) digest[side] = was.digest[side];
      else delete digest[side];
      if (was?.remote?.[side] !== undefined) remote[side] = was.remote[side];
      else delete remote[side];
    }
    if (issuePairs.some((pair) => pair.eidos === 'parent')) digest['parent'] = short(parentIssue);
    const changes: string[] = [];
    const local: string[] = [];
    if (task) {
      for (const eidos of Object.keys(digest)) {
        if (eidos === 'parent') {
          const want = parentIssue === null ? null : (held.get(parentIssue)?.id ?? 'new');
          if ((task.parent ?? null) !== want) changes.push('parent');
          continue;
        }
        if (absent.has(eidos)) continue;
        const now = heldValue(task, eidos);
        if (short(normalise(now)) !== short(normalise(intendedValue(fields, eidos)))) changes.push(eidos);
        // edited in the root: what it holds is no longer what the last pull wrote
        if (was?.digest?.[eidos] !== undefined && was.digest[eidos] !== short(normalise(now))) local.push(eidos);
      }
    }
    const comments = context.comments ? await commentsToPull(context, issue, task, was, options) : null;
    plan.attachments += media.downloads.length;
    const owned = task ? issuePairs.filter((pair) => pair.owner === 'eidos' && changes.includes(pair.eidos)).map((pair) => pair.eidos) : [];
    intents.push({ issue: seen, task, type, fields, digest, remote, changes, local: local.filter((eidos) => changes.includes(eidos)), owned, parentIssue, parentKey, comments, absent });
    if (owned.length > 0) plan.owned.push({ key: issue.key, task: task!.id ?? task!.name, fields: owned });
    if (!task) plan.add.push({ key: issue.key, title: fields.title ?? issue.key, type });
    else if (changes.length > 0 || was?.key !== issue.key || was?.gone !== undefined) plan.change.push({ key: issue.key, task: task.id ?? task.name, fields: changes });
    else plan.unchanged += 1;
    const localHere = local.filter((eidos) => changes.includes(eidos));
    if (task && localHere.length > 0) plan.local.push({ key: issue.key, task: task.id ?? task.name, fields: localHere });
    if (comments && context.comments) {
      const textOf = (comment: JiraComment): string => adfToMarkdown(comment.body, { mention, media: media.link }) || '(empty)';
      const counted = countComments(context.comments, task, comments, issue, textOf);
      plan.comments.add += counted.add;
      plan.comments.change += counted.change;
      plan.comments.remove += counted.remove;
      for (const comment of comments) people.of(comment.author);
    }
  }

  // REQ11: an issue gone from the scope leaves its task where it is, marked
  for (const [id, task] of held) {
    const was = heldOf(task)!;
    if (inScope.has(id) || skipOf(task)) continue;
    if (projectOf(was.key) !== connection.project && !connection.jql && connection.board === undefined) continue;
    if (was.gone === undefined) plan.gone.push({ key: was.key, task: task.id ?? task.name });
  }
  for (const intent of intents) if (intent.task && heldOf(intent.task)?.gone !== undefined) plan.back.push({ key: intent.issue.key, task: intent.task.id ?? intent.task.name });

  // REQ9: links between pulled issues, each read from the side that holds the outward issue
  const links: Array<{ from: string; type: string; to: string }> = [];
  for (const intent of intents) {
    for (const link of intent.issue.fields.issuelinks ?? []) {
      if (!link.outwardIssue) continue;
      const type = linkTypeFor(connection.mapping, board, link.type.name);
      if (!type || !carried.has(link.outwardIssue.id)) {
        plan.left_out.links += 1;
        continue;
      }
      links.push({ from: intent.issue.id, type, to: link.outwardIssue.id });
    }
  }
  const declared = new Set(backlog.milestones().map((milestone) => milestone.name.toLowerCase()));
  plan.people = [...people.added].sort();
  plan.milestones = [...sprints.keys()].filter((name) => !declared.has(name.toLowerCase())).sort();

  if (!write) {
    writeState(host.workspace, connection.name, { ...state, last_fetch: { at: now.toISOString(), count: plan.add.length + plan.change.length + plan.gone.length } });
    return { plan, done: null };
  }

  // ---- the writes ----------------------------------------------------------------
  const done: Done = { connection: connection.name, added: 0, changed: 0, kept_local: 0, comments: { added: 0, changed: 0, removed: 0 }, people: 0, gone: 0, attachments: 0, left_out: plan.left_out };
  const keyedId = (key: string): string => `T-${key}`;
  // a sprint becomes a milestone of its name, dated when it ends, before any task names it
  for (const name of plan.milestones) await backlog.addMilestone({ name, date: sprints.get(name) ?? null });
  for (const intent of intents) {
    const { issue } = intent;
    const index = byIssue();
    const task = index.get(issue.id) ?? null;
    const was = task ? heldOf(task) : null;
    const fields: TaskFields = { ...intent.fields };
    const digest = { ...intent.digest };
    const remote = { ...intent.remote };
    // --keep-local, and a field the root owns: the root's value is kept, and its digest as it was, so it still reads as edited
    const kept = task ? [...new Set([...(options.keepLocal ? intent.local : []), ...intent.owned])] : [];
    if (task && kept.length > 0) {
      for (const eidos of kept) {
        dropField(fields, eidos);
        if (was?.digest?.[eidos] !== undefined) digest[eidos] = was.digest[eidos];
        // and Jira's value as it was, so a sync still sees that Jira changed it
        if (was?.remote?.[eidos] !== undefined) remote[eidos] = was.remote[eidos];
        else delete remote[eidos];
      }
      if (options.keepLocal && intent.local.length > 0) done.kept_local += 1;
    }
    const parentTask = intent.parentIssue ? index.get(intent.parentIssue) : undefined;
    const typePairs = fieldsFor(pairs, issue.fields.issuetype?.name ?? '');
    const issuePairs = partPairs(typePairs, bundlesOf(typePairs));
    if (issuePairs.some((pair) => pair.eidos === 'parent') && !kept.includes('parent')) fields.parent = parentTask ? (parentTask.id ?? parentTask.name) : null;
    const downloads = await downloadAttachments(context, issue, task);
    done.attachments += downloads;
    const adfAgain: AdfContext = { mention, media: attachmentsFor(context, issue, task).link };
    // the text read again once attachments are in the root, so a reference points at the file
    if (downloads > 0) rewriteTexts(fields, issuePairs, issue, board, adfAgain);
    const jira: Held = {
      site,
      id: issue.id,
      key: issue.key,
      ...(moment(issue.fields.updated) ? { updated: moment(issue.fields.updated)! } : {}),
      ...(intent.comments ? { comments: commentMark(intent.comments) } : was?.comments ? { comments: was.comments } : {}),
      ...(intent.parentKey && !parentTask ? { parent: intent.parentKey } : {}),
      digest: Object.fromEntries(Object.entries(digest).sort(([a], [b]) => a.localeCompare(b))),
      remote: Object.fromEntries(Object.entries(remote).sort(([a], [b]) => a.localeCompare(b))),
      ...(was?.connection ? { connection: was.connection } : {}),
    };
    const dates = { ...(moment(issue.fields.updated) ? { updated: moment(issue.fields.updated)! } : {}) };
    let written: TaskView;
    if (!task) {
      const created = moment(issue.fields.created);
      const make = { ...fields, title: fields.title ?? issue.key, ...dates, ...(created ? { created } : {}), tool: { jira } };
      if (make.parent) written = backlog.create(make);
      else {
        try {
          written = backlog.create({ ...make, id: keyedId(issue.key) });
        } catch (cause) {
          // REQ4: an id another task already holds; the pull draws one as usual, and the check names two tasks on one issue
          if (!/already held/.test(cause instanceof Error ? cause.message : '')) throw cause;
          written = backlog.create(make);
        }
      }
      done.added += 1;
    } else {
      // only what changes is written, so a pull that finds the task as Jira has it leaves the file as it is
      for (const eidos of Object.keys(digest)) {
        const differs = eidos === 'parent' ? intent.changes.includes('parent') : short(normalise(heldValue(task, eidos))) !== short(normalise(intendedValue(fields, eidos)));
        if (!differs) dropField(fields, eidos);
      }
      if (fields.sections && Object.keys(fields.sections).length === 0) delete fields.sections;
      if (fields.properties && Object.keys(fields.properties).length === 0) delete fields.properties;
      written = backlog.set(task.id ?? task.name, { ...fields, ...dates, tool: { jira } });
      // counted when anything of the task was written, a reference pointed at a file just downloaded included
      if (Object.keys(fields).length > 0 || was?.key !== issue.key || was?.gone !== undefined) done.changed += 1;
    }
    // the digest of what the task holds now, after the Backlog wrote it (a section's text as its region reads), so the next fetch compares like with like
    const settled = Object.fromEntries(
      Object.keys(jira.digest!).map((eidos) => [eidos, eidos === 'parent' || kept.includes(eidos) || intent.absent.has(eidos) ? jira.digest![eidos]! : short(normalise(heldValue(written, eidos)))]),
    );
    if (JSON.stringify(settled) !== JSON.stringify(jira.digest)) written = backlog.set(written.id ?? written.name, { ...dates, tool: { jira: { ...jira, digest: settled } } });
    if (context.pullAttachments) linkAttachments(context, written, issue);
    if (intent.comments && context.comments) {
      const counted = applyComments(context, written, intent.comments, issue, mention, people);
      done.comments.added += counted.add;
      done.comments.changed += counted.change;
      done.comments.removed += counted.remove;
    }
  }

  // links, once every task is in place
  const index = byIssue();
  const pulledLinks = new Map<string, Set<string>>();
  for (const link of links) {
    const from = index.get(link.from);
    const to = index.get(link.to);
    if (!from || !to) continue;
    const toRef = to.id ?? to.name;
    pulledLinks.set(link.from, (pulledLinks.get(link.from) ?? new Set()).add(`${link.type}>${toRef.toLowerCase()}`));
    if (from.links.some((held) => held.type === link.type && held.task.toLowerCase() === toRef.toLowerCase() && held.direction === 'outward')) continue;
    try {
      backlog.link(from.id ?? from.name, link.type, toRef, 'outward');
    } catch {
      // the two already hold it, read the other way; the link stands as it is
    }
  }
  // a link between two pulled tasks that Jira no longer holds is taken out; a link to a task not pulled is the root's
  const relinked = new Set<string>();
  for (const link of links) relinked.add(link.from);
  for (const intent of intents) {
    const from = index.get(intent.issue.id);
    if (!from) continue;
    const pulledIds = new Set([...index.values()].map((task) => (task.id ?? task.name).toLowerCase()));
    const keep = pulledLinks.get(intent.issue.id) ?? new Set<string>();
    for (const link of backlog.get(from.id ?? from.name).links) {
      if (link.direction !== 'outward' || !pulledIds.has(link.task.toLowerCase())) continue;
      if (!keep.has(`${link.type}>${link.task.toLowerCase()}`)) {
        backlog.unlink(from.id ?? from.name, link.type, link.task, 'outward');
        relinked.add(intent.issue.id);
      }
    }
  }
  // a link written stamps the task's updated; it is put back to Jira's, so the same Jira state writes the same file
  for (const intent of intents) {
    const task = byIssue().get(intent.issue.id);
    const want = moment(intent.issue.fields.updated);
    if (task && want && relinked.has(intent.issue.id) && task.updated !== want) backlog.set(task.id ?? task.name, { updated: want });
  }

  const today = now.toISOString().slice(0, 10);
  for (const gone of plan.gone) {
    const task = [...byIssue().values()].find((candidate) => heldOf(candidate)?.key === gone.key);
    if (!task) continue;
    const jira = heldOf(task)!;
    backlog.set(task.id ?? task.name, { ...(task.updated ? { updated: task.updated } : {}), tool: { jira: { ...jira, gone: today } } });
    done.gone += 1;
  }

  done.people = people.added.size;
  writeState(host.workspace, connection.name, { ...state, last_pull: now.toISOString(), last_fetch: { at: now.toISOString(), count: 0 } });
  return { plan, done };
}

// The task fields one issue's mapped pairs give, as a pull writes them and a sync compares them.
export interface Intended {
  fields: TaskFields;
  parentIssue: string | null;
  parentKey: string | null;
  parentLeftOut: boolean;
  sprint: { name: string; end: string | null } | null;
}

export function intendFields(
  connection: Connection,
  board: BoardSettings,
  issue: Issue,
  type: string,
  issuePairs: Pair[],
  people: People,
  adf: AdfContext,
  carried: Set<string>,
  jiraPriorities: string[] = [],
): Intended {
  const fields: TaskFields = { type };
  const out: Intended = { fields, parentIssue: null, parentKey: null, parentLeftOut: false, sprint: null };
  for (const pair of issuePairs) {
    const value = issue.fields[pair.jira];
    const [head, name = ''] = pair.eidos.split(/:(.*)/s);
    switch (head) {
      case 'title':
        fields.title = named(value)?.trim() || issue.key;
        break;
      case 'status': {
        const status = issue.fields.status;
        fields.status = status ? statusFor(connection.mapping, board, status.name, categoryOf(status.statusCategory?.key)) : board.default_status;
        break;
      }
      case 'priority':
        fields.priority = named(value) ? priorityFor(connection.mapping, board, named(value)!, jiraPriorities) : null;
        break;
      case 'assignee': {
        const users = (Array.isArray(value) ? value : value ? [value] : []) as JiraUser[];
        fields.assignee = users.map((user) => people.of(user)).flatMap((person) => (person ? [person.user ?? person.name] : []));
        break;
      }
      case 'milestone': {
        const sprint = latestSprint(value);
        if (sprint) out.sprint = sprint;
        fields.milestone = sprint ? sprint.name : named(value);
        break;
      }
      case 'parent': {
        const parent = issue.fields.parent;
        if (!parent) break;
        out.parentKey = parent.key;
        const rule = connection.mapping.parent ?? 'subtasks';
        const asParent = rule === 'all' || (rule === 'subtasks' && issue.fields.issuetype?.subtask === true);
        if (!asParent) break;
        if (carried.has(parent.id)) out.parentIssue = parent.id;
        else out.parentLeftOut = true;
        break;
      }
      case 'section':
        // a part of a bundled field whose heading Jira's text lacks is left as the root has it
        if (value === undefined && pair.jira !== realFieldOf(pair.jira)) break;
        fields.sections = { ...(fields.sections ?? {}), [name]: sectionText(value, board, pair.eidos, adf) };
        break;
      case 'property':
        fields.properties = { ...(fields.properties ?? {}), [name]: asProperty(value, board, name, adf) };
        break;
      default:
        break;
    }
  }
  if (fields.title === undefined) fields.title = named(issue.fields.summary) ?? issue.key;
  return out;
}

// ---- fields -----------------------------------------------------------------------

// A section's text from Jira: a checklist's task list read back as its numbered lines (Jira REQ21).
function sectionText(value: unknown, board: BoardSettings, side: string, adf: AdfContext): string {
  const text = asText(value, adf);
  return sectionOf(board, side)?.type === 'checklist' ? checklistFromJira(text) : text;
}

function asText(value: unknown, adf: AdfContext): string {
  if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc') return adfToMarkdown(value, adf);
  if (Array.isArray(value)) return value.map(named).filter(Boolean).join(', ');
  return named(value) ?? '';
}

function asProperty(value: unknown, board: BoardSettings, name: string, adf: AdfContext): unknown {
  const property = board.properties.find((held) => held.name.toLowerCase() === name.toLowerCase());
  const type = property?.type.toLowerCase() ?? 'text';
  if (value === null || value === undefined) return null;
  if (type === 'list') {
    const sprint = latestSprint(value);
    if (sprint && Array.isArray(value) && typeof value[0] === 'object') return value.map(named).filter((item): item is string => item !== null);
    return (Array.isArray(value) ? value : [value]).map(named).filter((item): item is string => item !== null);
  }
  if (type === 'number') return typeof value === 'number' ? value : Number(named(value)) || null;
  if (type === 'date') return typeof value === 'string' ? value.slice(0, 10) : null;
  return asText(value, adf) || null;
}

export function intendedValue(fields: TaskFields, eidos: string): unknown {
  const [head, name = ''] = eidos.split(/:(.*)/s);
  switch (head) {
    case 'title':
      return fields.title ?? null;
    case 'type':
      return fields.type ?? DEFAULT_TYPE;
    case 'status':
      return fields.status ?? null;
    case 'priority':
      return fields.priority ?? null;
    case 'assignee':
      return [...(fields.assignee ?? [])].sort();
    case 'milestone':
      return fields.milestone ?? null;
    case 'section':
      return (fields.sections?.[name] ?? '').trim();
    case 'property':
      return fields.properties?.[name] ?? null;
    default:
      return null;
  }
}

// One value as the digest compares it: an empty list, an empty text, and nothing read alike.
export function normalise(value: unknown): unknown {
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return null;
  if (typeof value === 'string') return value.trim();
  return value;
}

function dropField(fields: TaskFields, eidos: string): void {
  const [head, name = ''] = eidos.split(/:(.*)/s);
  if (head === 'section' && fields.sections) delete fields.sections[name];
  else if (head === 'property' && fields.properties) delete fields.properties[name];
  else if (head === 'title' || head === 'type' || head === 'status' || head === 'priority' || head === 'assignee' || head === 'milestone' || head === 'parent') delete fields[head];
}

function rewriteTexts(fields: TaskFields, pairs: Pair[], issue: Issue, board: BoardSettings, adf: AdfContext): void {
  for (const pair of pairs) {
    const [head, name = ''] = pair.eidos.split(/:(.*)/s);
    const value = issue.fields[pair.jira];
    if (head === 'section' && fields.sections && name in fields.sections) fields.sections[name] = sectionText(value, board, pair.eidos, adf);
    if (head === 'property' && fields.properties && name in fields.properties) fields.properties[name] = asProperty(value, board, name, adf);
  }
}

// ---- comments ----------------------------------------------------------------------

const threadIdOf = (issue: Issue): string => `t-jira-${issue.id}`;
const externalOf = (comment: JiraComment): string => `jira:${comment.id}`;
const commentMark = (comments: JiraComment[]): string =>
  `${comments.length}@${comments.reduce((latest, comment) => ((moment(comment.updated ?? comment.created) ?? '') > latest ? (moment(comment.updated ?? comment.created) ?? '') : latest), '')}`;

// The comments a pull keeps level for one issue, restricted ones left out
// unless the connection allows them; null when they have not changed since
// the last pull (REQ15), so none is read.
async function commentsToPull(context: Context, issue: Issue, task: TaskView | null, was: Held | null, options: PullOptions): Promise<JiraComment[] | null> {
  const inline = issue.fields.comment;
  if (task && was?.comments && !options.full && inline?.comments && inline.total !== undefined && inline.comments.length >= inline.total) {
    const kept = inline.comments.filter((comment) => !comment.visibility || context.connection.restricted_comments === true);
    if (commentMark(kept) === was.comments) return null;
  }
  const all = await allComments(context.client, issue);
  return all.filter((comment) => !comment.visibility || context.connection.restricted_comments === true);
}

function threadOf(comments: CommentsApi, task: TaskView | null, issue: Issue): ThreadView | null {
  if (!task?.id) return null;
  return comments.threads({ host: 'backlog', id: task.id }).find((thread) => thread.id === threadIdOf(issue)) ?? null;
}

// What a pull would do to an issue's thread, each comment's text written as the pull writes it (its mentions and its files
// as the pull carries them), so a comment the pull would leave as it is is never counted as one to change
function countComments(comments: CommentsApi, task: TaskView | null, pulled: JiraComment[], issue: Issue, textOf: (comment: JiraComment) => string): { add: number; change: number; remove: number } {
  const thread = threadOf(comments, task, issue);
  const held = new Map((thread?.messages ?? []).filter((message) => message.external?.startsWith('jira:')).map((message) => [message.external!, message]));
  const kept = new Set(pulled.map(externalOf));
  let add = 0;
  let change = 0;
  for (const comment of pulled) {
    const message = held.get(externalOf(comment));
    if (!message) add += 1;
    else if (message.text.trim() !== textOf(comment).trim()) change += 1;
  }
  return { add, change, remove: [...held.keys()].filter((external) => !kept.has(external)).length };
}

function applyComments(
  context: Context,
  task: TaskView,
  pulled: JiraComment[],
  issue: Issue,
  mention: (account: string, name: string) => string | null,
  people: People,
): { add: number; change: number; remove: number } {
  const comments = context.comments!;
  const counted = { add: 0, change: 0, remove: 0 };
  const media = attachmentsFor(context, issue, task).link;
  const textOf = (comment: JiraComment): string => adfToMarkdown(comment.body, { mention, media }) || '(empty)';
  let thread = threadOf(comments, task, issue);
  const kept = new Set(pulled.map(externalOf));
  // a message whose Jira comment was deleted, or became restricted, goes, the last first so the indexes hold
  if (thread) {
    const id = thread.id;
    const indexes = thread.messages.map((message, index) => ({ message, index })).filter(({ message }) => message.external?.startsWith('jira:') && !kept.has(message.external));
    for (const { index } of indexes.reverse()) {
      thread = comments.removeMessage(id, index);
      counted.remove += 1;
    }
  }
  for (const comment of pulled) {
    const text = textOf(comment);
    // signed by the root user of the author's name, else by the name Jira gives; a comment Jira gives no author for is signed "Jira", never by whoever runs the pull
    const person = people.of(comment.author) ?? { name: 'Jira', user: null };
    const as = (person.user ? comments.authorAs(person.user) : null) ?? { name: person.name, role: null, user: null };
    const origin = { written: comment.created, external: externalOf(comment) };
    const at = thread?.messages.findIndex((message) => message.external === externalOf(comment)) ?? -1;
    // a message a sync sent whose answer was lost before it was taken in: the same text, unsent as far as the thread
    // knows, signed by the root user the comment's author is; it becomes the comment, not a second copy of it
    const sentHere = thread && at < 0 && person.user ? thread.messages.findIndex((message) => !message.external && message.user === person.user && message.text.trim() === text.trim()) : -1;
    if (thread && sentHere >= 0) {
      const held = thread.messages[sentHere]!;
      comments.removeMessage(thread.id, sentHere);
      const still = comments.threads({ host: 'backlog', id: task.id! }).find((candidate) => candidate.id === threadIdOf(issue));
      const signer = { name: held.author, role: null, user: held.user ?? null };
      thread = still ? comments.reply(still.id, text, signer, origin) : comments.start({ host: 'backlog', id: task.id! }, null, text, signer, { ...origin, thread: threadIdOf(issue) });
      continue;
    }
    if (thread && at >= 0) {
      if (thread.messages[at]!.text.trim() !== text.trim()) {
        thread = comments.editMessage(thread.id, at, text);
        counted.change += 1;
      }
      continue;
    }
    thread = thread ? comments.reply(thread.id, text, as, origin) : comments.start({ host: 'backlog', id: task.id! }, null, text, as, { ...origin, thread: threadIdOf(issue) });
    counted.add += 1;
  }
  return counted;
}

// ---- attachments -------------------------------------------------------------------

const assetName = (attachment: JiraAttachment): string => `jira-${attachment.id}-${attachment.filename.replace(/[^\w.-]+/g, '-')}`;

function assetFolder(context: Context): string | null {
  return context.assets?.folders()[0]?.name ?? null;
}

// Where an issue's embedded files point (REQ14): the attachment in Jira, or
// its file in the root once a pull with pull_attachments downloaded it.
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

export function attachmentsFor(context: Context, issue: Issue, task: TaskView | null): { link: AdfContext['media']; downloads: JiraAttachment[] } {
  const attachments = issue.fields.attachment ?? [];
  const base = siteBase(context.connection.site);
  const files = context.pullAttachments && context.assets ? context.assets.files() : [];
  const downloads = context.pullAttachments && context.assets ? attachments.filter((attachment) => !files.some((file) => file.name === assetName(attachment))) : [];
  const folder = context.backlog.folder();
  return {
    downloads,
    link: (id, alt) => {
      const attachment = attachments.find((held) => alt !== null && held.filename === alt) ?? (attachments.length === 1 ? attachments[0] : undefined);
      // a file pasted into the text carries no name to know its attachment by; it is a link to the issue, one per file,
      // so it is not lost from the text and a sync sends it back as Jira's own
      if (!attachment) return { label: 'file in Jira', href: `${base}/browse/${issue.key}?media=${encodeURIComponent(id)}` };
      const file = files.find((held) => held.name === assetName(attachment));
      // one in the root is drawn as an image where it is one; one in Jira stays a link, since the page cannot read it without the person's Jira sign-in
      if (file && task)
        return { label: attachment.filename, href: path.relative(folder, path.join(context.host.context().root, file.path)).split(path.sep).join('/'), image: IMAGE.test(attachment.filename) };
      return { label: attachment.filename, href: `${base}/rest/api/3/attachment/content/${attachment.id}` };
    },
  };
}

async function downloadAttachments(context: Context, issue: Issue, task: TaskView | null): Promise<number> {
  const { downloads } = attachmentsFor(context, issue, task);
  const folder = assetFolder(context);
  if (!context.assets || !folder || downloads.length === 0) return 0;
  for (const attachment of downloads) {
    const bytes = await context.client.bytes(attachment.content);
    context.assets.add(folder, assetName(attachment), bytes);
  }
  return downloads.length;
}

// Each downloaded attachment of a task linked to it, once the task is written and has its name.
export function linkAttachments(context: Context, task: TaskView, issue: Issue): void {
  if (!context.assets) return;
  for (const attachment of issue.fields.attachment ?? []) {
    const file = context.assets.files().find((held) => held.name === assetName(attachment));
    if (file && !file.links.some((link) => link.kind === 'task' && link.ref === task.name)) context.assets.link(file.path, { kind: 'task', ref: task.name });
  }
}
