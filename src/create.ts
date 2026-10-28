// Jira Push: a Jira issue made from a Backlog task when the person asks, and
// the task linked to it, so from then on a sync carries it as it carries a
// pulled task (Jira Push REQ1 to REQ14). A create is planned first: the issue
// type, every value it sends and where the value came from, the parent, and
// whatever stops it, each with its fix; nothing of a batch is created while
// one of its tasks is stopped. The task is marked before Jira is asked, and
// the issue carries the mark as a property, so a create cut short is found
// again, never made twice.
import { randomUUID } from 'node:crypto';
import type { AdfContext } from './adf.ts';
import { JiraError } from './client.ts';
import { siteKey } from './connections.ts';
import { cachedDescription, keepDescription, readDescription, type Description, type JiraField, type JiraType } from './describe.ts';
import { fieldsFor, fieldsOf, syncOf, typeFor } from './mapping.ts';
import { heldOf, heldValue, intendFields, intendedValue, jqlMoment, moment, normalise, peopleFor, prioritiesOf, remoteOf, short, type Context, type Held, type Issue } from './pull.ts';
import { accountFor, copySide, priorityOut, SyncRefused, valueOut, type Blocker, type EditField } from './sync.ts';
import type { TaskFields, TaskView } from './types.ts';

export interface CreatePlan {
  task: string;
  connection: string;
  project: string;
  // the Jira issue type, null while it is not settled
  type: string | null;
  // each value sent: the Jira field, the value as shown, and where it came from
  fields: Array<{ jira: string; value: string; from: 'task' | 'default' | 'option' }>;
  parent: string | null;
  // mapped fields the type's create screen does not hold, carried by the first sync instead
  later: string[];
  blockers: Blocker[];
  // a create that was cut short and whose issue is being looked for
  recovering: boolean;
}

export interface CreateOptions {
  type?: string;
  // the tasks made in the same run, so a parent among them is not one that stops its sub-task
  batch?: Set<string>;
  fields?: Record<string, string>;
  // a mark older than a few minutes whose issue cannot be found is created again
  again?: boolean;
}

export interface Created {
  task: string;
  key: string;
  url: string;
  // mapped fields Jira holds otherwise than the task (the workflow's first status), which the next sync sends
  differs: string[];
  found: boolean;
}

interface Pending {
  site: string;
  connection: string;
  pending: string;
  since: string;
}

// A recently cut-short create is looked for, never repeated, until Jira's search has had time to list it.
const SEARCH_LAG_MS = 5 * 60_000;

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function pendingOf(task: TaskView): Pending | null {
  const value = task.properties['jira'];
  if (typeof value !== 'object' || value === null) return null;
  const held = value as Record<string, unknown>;
  return typeof held['pending'] === 'string' && typeof held['since'] === 'string' && typeof held['id'] !== 'string' ? (held as unknown as Pending) : null;
}

async function described(context: Context): Promise<Description> {
  const held = cachedDescription(context.host.workspace, context.connection.name);
  if (held) return held;
  const read = await readDescription(context.client, context.connection);
  keepDescription(context.host.workspace, read);
  return read;
}

const asEditField = (field: JiraField): EditField => ({
  name: field.name,
  required: field.required,
  schema: { type: field.type, ...(field.items ? { items: field.items } : {}), ...(field.system ? { system: field.system } : {}), ...(field.custom ? { custom: field.custom } : {}) },
  ...(field.allowed ? { allowedValues: field.allowed.map((name) => ({ name, value: name })) } : {}),
});

// The Jira issue type a task becomes: the one asked for, else the one the mapping names for its type, else the one
// Jira type that reads back as it. A type that would not read back as the task's own is refused, so the first sync
// never changes the task's type.
function typeOfTask(context: Context, description: Description, task: TaskView, asked: string | undefined, parentLinked: boolean): { type?: JiraType; blocker?: Blocker } {
  const board = context.backlog.settings();
  const mapping = context.connection.mapping;
  const back = description.types.filter((type) => same(typeFor(mapping, board, type.name) ?? '', task.type));
  const name = context.connection.name;
  const wanted = asked ?? mapping.create?.types?.[task.type] ?? mapping.types?.find((pair) => pair.push === true && same(pair.eidos, task.type))?.jira;
  if (wanted) {
    const found = back.find((type) => same(type.name, wanted));
    if (found) return { type: found };
    return {
      blocker: {
        side: 'type',
        code: 'unmapped',
        message: `${wanted} does not read back as the task's type ${task.type} (${back.map((type) => type.name).join(', ') || 'no Jira type does'})`,
        ...(back.length > 0 ? { ask: { kind: 'type' as const, choices: back.map((type) => type.name) } } : {}),
        fix: `--type "<one of ${back.map((type) => type.name).join(', ')}>", or eidos jira configure:map ${name} set types "<Jira type>" ${task.type}`,
      },
    };
  }
  // a subtask goes to a sub-task type when its parent has an issue, else to a type that stands on its own
  const fitting = back.filter((type) => type.subtask === parentLinked);
  const pool = fitting.length > 0 ? fitting : back.filter((type) => !type.subtask);
  if (pool.length === 1) return { type: pool[0]! };
  return {
    blocker: {
      side: 'type',
      code: pool.length === 0 ? 'unmapped' : 'ambiguous',
      message: pool.length === 0 ? `no Jira issue type reads as the task type ${task.type}` : `${task.type} is ${pool.map((type) => type.name).join(' or ')} in Jira`,
      ...(pool.length > 0 ? { ask: { kind: 'type' as const, choices: pool.map((type) => type.name) } } : {}),
      fix:
        pool.length === 0
          ? `eidos jira configure:map ${name} set types "<Jira type>" ${task.type}`
          : `--type "<one of ${pool.map((type) => type.name).join(', ')}>", or for every create: eidos jira configure:map ${name} set create.types ${task.type} "<Jira type>"`,
    },
  };
}

export interface PreparedCreate {
  plan: CreatePlan;
  task: TaskView;
  payload: { fields: Record<string, unknown> } | null;
  pending: Pending | null;
}

export async function prepareCreate(context: Context, task: TaskView, options: CreateOptions = {}): Promise<PreparedCreate> {
  const { connection, backlog } = context;
  const name = task.id ?? task.name;
  const linked = heldOf(task);
  if (linked) throw new SyncRefused(`${name} already holds ${linked.key}; eidos jira sync ${name} carries its changes`);
  const pending = pendingOf(task);
  const plan: CreatePlan = { task: name, connection: connection.name, project: connection.project, type: null, fields: [], parent: null, later: [], blockers: [], recovering: pending !== null };
  if (pending) {
    if (siteKey(pending.site) !== siteKey(connection.site)) throw new SyncRefused(`${name} was being created on ${pending.site}, not on ${connection.name}'s site`);
    return { plan, task, payload: null, pending };
  }
  const description = await described(context);
  const board = backlog.settings();
  const parentTask = task.parent ? backlog.tasks().find((other) => (other.id ?? other.name).toLowerCase() === task.parent!.toLowerCase()) : undefined;
  const parentHeld = parentTask ? heldOf(parentTask) : null;
  const parentComing = parentTask !== undefined && (options.batch?.has((parentTask.id ?? parentTask.name).toLowerCase()) ?? false);
  const chosen = typeOfTask(context, description, task, options.type, parentHeld !== null || parentComing);
  if (chosen.blocker) plan.blockers.push(chosen.blocker);
  const type = chosen.type;
  if (!type) return { plan, task, payload: null, pending: null };
  plan.type = type.name;

  const fields: Record<string, unknown> = { project: { key: connection.project }, issuetype: { id: type.id } };
  const onScreen = new Map(type.fields.map((field) => [field.id, field]));
  const ranks = await prioritiesOf(context);
  const adf: AdfContext = { mention: () => null, media: () => null };
  for (const pair of fieldsFor(fieldsOf(connection, board), type.name)) {
    const [head] = pair.eidos.split(':');
    if (syncOf(pair) === 'pull' || head === 'status' || head === 'type' || head === 'milestone') continue;
    if (head === 'parent') continue;
    const field = onScreen.get(pair.jira);
    const value = heldValue(task, pair.eidos);
    if (normalise(value) === null) continue;
    if (!field) {
      plan.later.push(pair.eidos);
      continue;
    }
    const edit = asEditField(field);
    let out;
    if (head === 'priority') out = priorityOut(context, board, edit, null, (value as string | null) ?? null, pair.eidos, ranks);
    else if (head === 'assignee') {
      const people = Array.isArray(value) ? (value as string[]) : [];
      if (people.length > 1) out = { blocker: { side: pair.eidos, code: 'value' as const, message: `a Jira issue has one assignee; the task has ${people.join(', ')}`, fix: 'keep one assignee on the task' } };
      else {
        const found = await accountFor(context, { project: connection.project }, people[0]!, pair.eidos);
        out = found.blocker ? { blocker: found.blocker } : { value: { accountId: found.accountId } };
      }
    } else out = valueOut(context, pair.jira, edit, value, null, adf, pair.eidos);
    if (out.blocker) plan.blockers.push(out.blocker);
    else if (out.kept) plan.later.push(pair.eidos);
    else if (out.value !== undefined && out.value !== null) {
      fields[pair.jira] = out.value;
      plan.fields.push({ jira: pair.jira, value: shownValue(value), from: 'task' });
    }
  }
  if (!fields['summary']) {
    fields['summary'] = task.title;
    plan.fields.push({ jira: 'summary', value: task.title, from: 'task' });
  }
  // the parent: a subtask's issue goes under its parent's
  if (parentTask && !parentHeld && !parentComing)
    plan.blockers.push({ side: 'parent', code: 'unmapped', message: `its parent ${parentTask.id ?? parentTask.name} has no Jira issue yet`, fix: `create ${parentTask.id ?? parentTask.name} first, or in the same run` });
  if (parentHeld && onScreen.has('parent')) {
    fields['parent'] = { id: parentHeld.id };
    plan.parent = parentHeld.key;
  }
  // a value for each field Jira requires that the task leaves empty: the person's, else the connection's create defaults
  const given = { ...(connection.mapping.create?.fields ?? {}), ...(options.fields ?? {}) };
  for (const [key, raw] of Object.entries(given)) {
    const field = type.fields.find((held) => held.id === key || same(held.name, key));
    if (!field) {
      if (options.fields && key in options.fields) plan.blockers.push({ side: null, code: 'value', message: `${type.name} has no field ${key} on its create screen`, fix: `eidos jira describe ${connection.name} lists its fields` });
      continue;
    }
    if (fields[field.id] !== undefined) continue;
    const out = valueOut(context, field.id, asEditField(field), raw, null, adf, field.id);
    if (out.blocker) plan.blockers.push(out.blocker);
    else if (out.value !== undefined && out.value !== null) {
      fields[field.id] = out.value;
      plan.fields.push({ jira: field.id, value: raw, from: options.fields && key in options.fields ? 'option' : 'default' });
    }
  }
  for (const field of type.fields) {
    if (!field.required || field.defaulted || fields[field.id] !== undefined) continue;
    if (['project', 'issuetype', 'summary', 'reporter'].includes(field.id)) continue;
    if (field.id === 'parent') {
      if (!parentTask) plan.blockers.push({ side: 'parent', code: 'required', message: `a ${type.name} sits under a parent issue, and the task has no parent`, fix: 'give the task a parent, or --type a type that stands on its own' });
      continue;
    }
    plan.blockers.push({
      side: null,
      code: 'required',
      message: `${type.name} requires ${field.name} (${field.id}), which the task does not hold`,
      ask: { kind: 'field', field: field.id, choices: field.allowed ?? [] },
      fix: `--field ${field.id}="<${field.allowed ? field.allowed.join(' | ') : 'value'}>", or create_defaults in the mapping: eidos jira configure:map ${connection.name} set create.fields ${field.id} "<value>"`,
    });
  }
  return { plan, task, payload: { fields }, pending: null };
}

const shownValue = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, 80) : String(value));

// The issue made, or the one a create cut short made, found by the mark it carries; then the task linked to it with
// both bases read from Jira, so a field Jira holds otherwise (its first status) reads as the task's edit at the next sync.
export async function create(context: Context, prepared: PreparedCreate, options: CreateOptions = {}): Promise<Created> {
  const { backlog, client, connection } = context;
  const name = prepared.task.id ?? prepared.task.name;
  let issueRef: { id: string; key: string } | null = null;
  let found = false;
  if (prepared.pending) {
    issueRef = await findPending(context, prepared.pending);
    found = issueRef !== null;
    if (!issueRef) {
      const age = Date.now() - Date.parse(prepared.pending.since);
      if (age < SEARCH_LAG_MS || !options.again)
        throw new SyncRefused(
          age < SEARCH_LAG_MS
            ? `${name}'s create was cut short a moment ago and Jira does not list its issue yet; try again in a few minutes`
            : `${name}'s create was cut short and no issue in ${connection.project} carries its mark; check Jira, then --again creates it anew`,
        );
      // the mark taken off, so the task is planned again from what it holds now
      backlog.set(name, { tool: { jira: null } });
      const fresh = await prepareCreate(context, backlog.get(name), options);
      return create(context, fresh, { ...options, again: false });
    }
  } else {
    if (!prepared.payload || prepared.plan.blockers.length > 0) throw new SyncRefused(`${name} is not created: ${prepared.plan.blockers.length} thing${prepared.plan.blockers.length === 1 ? '' : 's'} to settle first`);
    const mark: Pending = { site: siteKey(connection.site), connection: connection.name, pending: randomUUID(), since: new Date().toISOString() };
    backlog.set(name, { tool: { jira: { ...mark } } });
    try {
      issueRef = await client.post<{ id: string; key: string }>('/rest/api/3/issue', {
        ...prepared.payload,
        properties: [{ key: 'eidos', value: { task: name, pending: mark.pending } }],
      });
    } catch (cause) {
      // Jira refusing the create (a 4xx: a field it would not take) made no issue, so the mark comes off; a lost answer
      // or a 5xx may have made one, and the mark stays for the next create to look for it
      if (cause instanceof JiraError && cause.status !== null && cause.status >= 400 && cause.status < 500) backlog.set(name, { tool: { jira: null } });
      throw cause;
    }
  }
  const linked = await link(context, backlog.get(name), issueRef!);
  return { ...linked, found };
}

// The issue a cut-short create made, by the mark it carries: the project's issues made since a little before the mark,
// each asked for its own property, which does not wait on the search's index.
async function findPending(context: Context, pending: Pending): Promise<{ id: string; key: string } | null> {
  // JQL reads a moment in the person's own time zone, as a pull writes its watermark
  const stamp = jqlMoment(new Date(Date.parse(pending.since) - 2 * 60_000), context.timeZone);
  const jql = `project = "${context.connection.project}" AND created >= "${stamp}" ORDER BY created DESC`;
  let nextPageToken: string | undefined;
  // the issues made in those few minutes, a few pages at most; a project busier than that is looked through no further
  for (let page = 0; page < 5; page += 1) {
    const found = await context.client.post<{ issues?: Array<{ id: string; key: string }>; nextPageToken?: string; isLast?: boolean }>('/rest/api/3/search/jql', {
      jql,
      fields: ['id'],
      maxResults: 50,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    for (const issue of found.issues ?? []) {
      const property = await context.client.get<{ value?: { pending?: string } }>(`/rest/api/3/issue/${issue.id}/properties/eidos`).catch(() => null);
      if (property?.value?.pending === pending.pending) return { id: issue.id, key: issue.key };
    }
    if (!found.nextPageToken || found.isLast === true) return null;
    nextPageToken = found.nextPageToken;
  }
  return null;
}

async function link(context: Context, task: TaskView, ref: { id: string; key: string }): Promise<Omit<Created, 'found'>> {
  const { backlog, connection } = context;
  const name = task.id ?? task.name;
  const board = backlog.settings();
  const issue = await context.client.get<Issue>(`/rest/api/3/issue/${ref.id}`, {
    fields: [...new Set(['summary', 'description', 'status', 'priority', 'assignee', 'parent', 'issuetype', 'updated', 'created', ...fieldsOf(connection, board).map((pair) => pair.jira)])].join(','),
  });
  const pairs = fieldsFor(fieldsOf(connection, board), issue.fields.issuetype?.name ?? '');
  const people = peopleFor(context, false);
  const carried = new Set(backlog.tasks().flatMap((other) => (heldOf(other) ? [heldOf(other)!.id] : [])));
  const intended = intendFields(connection, board, issue, task.type, pairs, people, { mention: () => null, media: () => null }, carried, await prioritiesOf(context)).fields;
  const digest: Record<string, string> = { type: short(task.type) };
  const remote: Record<string, string> = {};
  const differs: string[] = [];
  // what Jira filled in that the task left empty (a default priority) is taken into the task, so it is not a difference
  // a sync keeps finding; a value the task holds that Jira does not (its own status) is left for the sync to send
  const filled: TaskFields = {};
  const settledHere: string[] = [];
  for (const pair of pairs) {
    remote[pair.eidos] = remoteOf(issue, pair);
    if (pair.eidos === 'parent') {
      digest['parent'] = short(issue.fields.parent?.id ?? null);
      continue;
    }
    const jiraValue = short(normalise(intendedValue(intended, pair.eidos)));
    digest[pair.eidos] = jiraValue;
    if (jiraValue === short(normalise(heldValue(task, pair.eidos)))) continue;
    if (normalise(heldValue(task, pair.eidos)) === null && pair.eidos !== 'type') {
      copySide(filled, intended, pair.eidos);
      settledHere.push(pair.eidos);
    } else differs.push(pair.eidos);
  }
  const updated = moment(issue.fields.updated);
  const jira: Held = {
    site: siteKey(connection.site),
    id: issue.id,
    key: issue.key,
    ...(updated ? { updated } : {}),
    comments: '0@',
    connection: connection.name,
    digest: Object.fromEntries(Object.entries(digest).sort(([a], [b]) => a.localeCompare(b))),
    remote: Object.fromEntries(Object.entries(remote).sort(([a], [b]) => a.localeCompare(b))),
  };
  const written = backlog.set(name, { ...filled, tool: { jira } });
  // the digest of a side taken from Jira as the task holds it once written, as a pull settles one
  if (settledHere.length > 0) {
    for (const side of settledHere) jira.digest![side] = short(normalise(heldValue(written, side)));
    backlog.set(name, { tool: { jira: { ...jira, digest: Object.fromEntries(Object.entries(jira.digest!).sort(([a], [b]) => a.localeCompare(b))) } } });
  }
  return { task: name, key: issue.key, url: `https://${siteKey(connection.site)}/browse/${issue.key}`, differs };
}

// The tasks of a batch with each task's parent before it, so a sub-task's parent has its issue when it is made.
export function parentsFirst(tasks: TaskView[]): TaskView[] {
  const names = new Map(tasks.map((task) => [(task.id ?? task.name).toLowerCase(), task]));
  const out: TaskView[] = [];
  const seen = new Set<string>();
  const visit = (task: TaskView): void => {
    const key = (task.id ?? task.name).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const parent = task.parent ? names.get(task.parent.toLowerCase()) : undefined;
    if (parent) visit(parent);
    out.push(task);
  };
  for (const task of tasks) visit(task);
  return out;
}
