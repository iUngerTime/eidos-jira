// Jira Sync: one pulled task and its issue brought level, field by field,
// when the person asks (Jira Sync REQ1 to REQ12). Each mapped field is judged
// against what the last pull or sync recorded of both sides: the task's value
// (the digest) and Jira's own value (the remote base). A field changed on one
// side goes to the other; changed on both, it is the person's to settle before
// anything of that issue is written. Nothing is sent that Jira already holds,
// a field Jira changed while the sync ran is never written over, and only the
// person's own messages in the issue's thread are sent.
//
//   read issue ─► judge fields ─► plan (shown) ─► person settles conflicts
//        │                                            │
//        └──── journal ◄── task (from Jira) ◄─────────┘
//                 │
//                 └─► guard ─► Jira (fields, transitions, comments) ─► read back ─► settle bases
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adfToMarkdown, type AdfContext } from './adf.ts';
import { JiraError, siteBase, type Requester } from './client.ts';
import { siteKey, type Connection, type Pair } from './connections.ts';
import { cachedDescription, categoryOf, keepDescription, readDescription, type Description, type JiraType } from './describe.ts';
import { knownOf, lostNodes, markdownToAdf, type AdfDoc } from './markdown.ts';
import { bundlesOf, composeText, partPairs, realField, splitIssue, type Bundle } from './bundle.ts';
import { fieldsFor, fieldsOf, priorityFor, statusFor, syncOf, typeFor } from './mapping.ts';
import {
  attachmentsFor,
  heldOf,
  heldValue,
  intendFields,
  intendedValue,
  moment,
  normalise,
  peopleFor,
  rawOf,
  remoteOf,
  short,
  skipOf,
  type Context,
  type Held,
  type Issue,
  type JiraUser,
} from './pull.ts';
import type { BacklogApi, BoardSettings, TaskFields, TaskView, ThreadView } from './types.ts';

// ---- the plan ---------------------------------------------------------------------

export type Verdict = 'unchanged' | 'from-jira' | 'to-jira' | 'same' | 'conflict';

export interface FieldPlan {
  // the Eidos side (title, status, section:description, property:points) and the Jira field it is paired with
  side: string;
  jira: string;
  verdict: Verdict;
  // the two values as the person reads them: the task's, and Jira's as the mapping writes it
  eidos: string;
  remote: string;
  // Jira's own value as this plan read it, hashed: a sync confirmed on this plan is refused if Jira holds another by then
  seen: string;
  // why a conflict is one, or why a field that changed here is not sent
  reason?: string;
  // a field changed here that is kept in the root and named, not sent (a read-only field, one off the edit screen)
  kept?: boolean;
  // a section's two values whole, for the review to set side by side line by line
  text?: { eidos: string; remote: string };
}

export interface Blocker {
  side: string | null;
  code: 'conflict' | 'unmapped' | 'ambiguous' | 'unreachable' | 'required' | 'loss' | 'person' | 'value' | 'unrecorded';
  message: string;
  fix: string;
  // what the page offers to settle it: a status to go to, a status to pass through, or a screen field's value
  ask?: { kind: 'status_to' | 'via' | 'field' | 'type'; field?: string; choices: string[] };
}

export interface CommentPlan {
  index: number;
  text: string;
}

export interface StatusPlan {
  from: string;
  to: string;
  // the Jira statuses walked through, the last the one asked for
  path: string[];
  fields: Record<string, unknown>;
}

export interface SyncPlan {
  task: string;
  key: string;
  url: string;
  connection: string;
  fields: FieldPlan[];
  status: StatusPlan | null;
  comments: CommentPlan[];
  blockers: Blocker[];
  // what writing the text would take out of Jira, by field, agreed to with --accept-loss
  loss: Record<string, Array<{ kind: string; count: number }>>;
  // nothing to do on either side
  level: boolean;
}

export interface SyncOptions {
  // a field settled by the person: the side (or `all`) to Jira's or to the task's value
  take?: Record<string, 'jira' | 'eidos'>;
  // the fields whose loss of what markdown cannot hold is agreed to
  acceptLoss?: string[];
  // the Jira statuses to pass through on the way to the one asked for, in order
  via?: string[];
  // the Jira status to go to when several map to the task's status
  statusTo?: string;
  // a transition screen's fields, by id or name
  transitionFields?: Record<string, string>;
  // leave the person's messages in the issue's thread unsent
  noComments?: boolean;
  // Jira's own value per field as the plan the person confirmed read it (each field's `seen`): a field Jira changed since
  // stops the issue, so a side taken, a loss agreed to, or a value sent is never one the person did not see
  expect?: Record<string, string>;
}

export interface SyncDone {
  task: string;
  key: string;
  to_jira: string[];
  from_jira: string[];
  settled: string[];
  status: string | null;
  comments: number;
  // what Jira kept other than what was sent (a post function, a value it normalised): the field and Jira's value
  kept_by_jira: Array<{ side: string; value: string }>;
}

export class SyncRefused extends Error {}

// ---- reading -------------------------------------------------------------------------

interface Transition {
  id: string;
  name: string;
  hasScreen?: boolean;
  to: { id: string; name: string; statusCategory?: { key?: string } };
  fields?: Record<
    string,
    { required?: boolean; hasDefaultValue?: boolean; name?: string; schema?: { type?: string; system?: string }; allowedValues?: Array<{ id?: string; name?: string; value?: string }> }
  >;
}

export interface EditField {
  required?: boolean;
  name?: string;
  schema?: { type?: string; items?: string; system?: string; custom?: string };
  allowedValues?: Array<{ id?: string; name?: string; value?: string }>;
  operations?: string[];
}

interface Read {
  // the issue as the sync compares it, each bundled field split into its sections' parts (Jira REQ21)
  issue: Issue & { editmeta?: { fields?: Record<string, EditField> }; transitions?: Transition[] };
  // the issue as Jira holds it, which a bundled field is written against
  whole: Read['issue'];
  type: JiraType | null;
}

const BASE_FIELDS = ['summary', 'description', 'status', 'priority', 'assignee', 'parent', 'issuetype', 'comment', 'attachment', 'updated', 'created'];

async function readIssue(context: Context, id: string, pairs: Pair[]): Promise<Read['issue']> {
  const fields = [...new Set([...BASE_FIELDS, ...pairs.map((pair) => realField(pair.jira))])].join(',');
  return context.client.get(`/rest/api/3/issue/${encodeURIComponent(id)}`, { fields, expand: 'editmeta,transitions.fields' });
}

async function description(context: Context): Promise<Description> {
  const held = cachedDescription(context.host.workspace, context.connection.name);
  if (held) return held;
  const read = await readDescription(context.client, context.connection);
  keepDescription(context.host.workspace, read);
  return read;
}

// Mentions and files read as the pull reads them (a file downloaded into the root as its path there), so a text
// compared after a write reads as it did before it.
function adfFor(context: Context, issue: Issue, task: TaskView, people: ReturnType<typeof peopleFor>): AdfContext {
  return {
    mention: (account, name) => people.of({ accountId: account, displayName: name })?.user ?? null,
    media: attachmentsFor(context, issue, task).link,
  };
}

// ---- judging ---------------------------------------------------------------------------

const RICH = new Set(['description', 'environment']);
const isDoc = (field: EditField | undefined, id: string): boolean =>
  RICH.has(id) || field?.schema?.system === 'description' || field?.schema?.custom === 'com.atlassian.jira.plugin.system.customfieldtypes:textarea';

// A value as the plan shows it to a person.
function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(none)';
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.map(shown).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value).trim();
  return text.length > 120 ? `${text.slice(0, 117).replace(/\s+/g, ' ')}...` : text.replace(/\s+/g, ' ');
}

// The document a text is once written as Jira holds it, its editor's local ids aside, so a section whose list markers or
// emphasis the linter rewrote is the same document and nothing is sent; a paragraph split or joined is not.
const canonicalText = (markdown: string): string => JSON.stringify(rawOf(markdownToAdf(markdown)));

// ---- the reverse of the mapping ---------------------------------------------------------

export interface Outgoing {
  value?: unknown;
  // not sent, and why; the field stays as the root has it
  kept?: string;
  blocker?: Blocker;
  lost?: Array<{ kind: string; count: number }>;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// The Jira priority a Backlog priority goes to: the current one when it already maps to it, else the one the mapping
// marks `push`, else the one Jira priority that maps to it.
export function priorityOut(context: Context, board: BoardSettings, field: EditField | undefined, current: unknown, wanted: string | null, side: string, ranks: string[]): Outgoing {
  if (wanted === null) return { kept: 'a priority cannot be taken off a Jira issue' };
  const allowed = (field?.allowedValues ?? []).filter((value) => value.name);
  const currentName = (current as { name?: string } | null)?.name ?? null;
  if (currentName && same(priorityFor(context.connection.mapping, board, currentName, ranks) ?? '', wanted)) return { value: { name: currentName } };
  const preferred = context.connection.mapping.priorities?.find((pair) => pair.push === true && same(pair.eidos, wanted))?.jira;
  if (preferred) {
    const found = allowed.find((value) => same(value.name!, preferred));
    if (found || allowed.length === 0) return { value: found?.id ? { id: found.id } : { name: preferred } };
  }
  const candidates = allowed.filter((value) => same(priorityFor(context.connection.mapping, board, value.name!, ranks) ?? '', wanted));
  if (candidates.length === 1) return { value: { id: candidates[0]!.id } };
  const names = candidates.map((value) => value.name!);
  return {
    blocker: {
      side,
      code: candidates.length === 0 ? 'unmapped' : 'ambiguous',
      message: candidates.length === 0 ? `no Jira priority maps to ${wanted}` : `${wanted} is ${names.join(' or ')} in Jira`,
      // a priorities part names every priority a pull carries, so one is marked only once the part is whole
      fix:
        context.connection.mapping.priorities === undefined
          ? `eidos jira map ${context.connection.name} drafts the priorities part; then eidos jira configure:map ${context.connection.name} set priorities "<${names.join(' | ') || 'Jira priority'}>" ${wanted} --push`
          : `eidos jira configure:map ${context.connection.name} set priorities "<${names.join(' | ') || 'Jira priority'}>" ${wanted} --push`,
    },
  };
}

// A root person as the Jira account Jira finds for them: the mapping's `users` entry, else Jira's assignable people of
// that name or email, one exactly; the account is kept on this machine for the next sync, never on the user.
export async function accountFor(context: Context, scope: { issueKey: string } | { project: string }, person: string, side: string): Promise<{ accountId?: string; blocker?: Blocker }> {
  const mapped = context.connection.mapping.users?.find((pair) => same(pair.eidos, person))?.jira;
  if (mapped && /^[0-9a-f]{24}$|^\d+:[0-9a-f-]{20,}$/i.test(mapped)) return { accountId: mapped };
  const cache = accountsCache(context);
  const cached = cache.read()[`${person.toLowerCase()}`];
  if (cached) return { accountId: cached };
  const name = context.comments?.authorAs(person)?.name ?? person;
  const query = mapped ?? name;
  const found = await context.client.get<JiraUser[]>('/rest/api/3/user/assignable/search', { ...scope, query, maxResults: 20 });
  const where = 'issueKey' in scope ? scope.issueKey : scope.project;
  const exact = found.filter((user) => same(user.displayName ?? '', query) || same(user.emailAddress ?? '', query));
  if (exact.length === 1) {
    cache.write({ ...cache.read(), [person.toLowerCase()]: exact[0]!.accountId });
    return { accountId: exact[0]!.accountId };
  }
  return {
    blocker: {
      side,
      code: 'person',
      message: exact.length === 0 ? `no one Jira can assign ${where} to is called ${query}` : `${exact.length} people Jira can assign ${where} to are called ${query}`,
      fix: `eidos jira configure:map ${context.connection.name} set users "<their Jira email or account id>" ${person}`,
    },
  };
}

function accountsCache(context: Context): { read(): Record<string, string>; write(next: Record<string, string>): void } {
  const file = path.join(context.host.workspace, 'local', `accounts-${siteKey(context.connection.site).replace(/[^a-z0-9.-]+/g, '-')}.json`);
  return {
    read: () => {
      try {
        return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
      } catch {
        return {};
      }
    },
    write: (next) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}

// An option a Jira field allows, by its name or value; undefined when it allows none of that name.
const optionOf = (field: EditField | undefined, value: string): { id?: string; value?: string; name?: string } | undefined =>
  field?.allowedValues?.find((allowed) => same(allowed.value ?? allowed.name ?? '', value));

// One property's or section's value as the Jira field's schema takes it.
export function valueOut(context: Context, pairJira: string, field: EditField | undefined, value: unknown, current: unknown, adf: AdfContext, side: string): Outgoing {
  if (isDoc(field, pairJira)) {
    const markdown = typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value);
    if (markdown.trim() === '') return { value: null, lost: lostNodes(current, { type: 'doc', version: 1, content: [] }) };
    const doc: AdfDoc = markdownToAdf(markdown, knownOf(current, adf));
    return { value: doc, lost: lostNodes(current, doc) };
  }
  const type = field?.schema?.type ?? 'string';
  const items = field?.schema?.items;
  const list = (Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]).map((item) => String(item));
  const one = list[0] ?? null;
  const bad = (message: string): Outgoing => ({ blocker: { side, code: 'value', message, fix: `change ${side} on the task, or take Jira's value (--take ${side}=jira)` } });
  switch (type) {
    case 'string':
      if (one !== null && /\n/.test(one) && pairJira === 'summary') return bad('a Jira summary is one line');
      if (one !== null && one.length > 255 && pairJira === 'summary') return bad('a Jira summary holds up to 255 characters');
      return { value: one };
    case 'number': {
      if (one === null) return { value: null };
      const number = Number(one);
      return Number.isFinite(number) ? { value: number } : bad(`'${one}' is not a number`);
    }
    case 'date':
      if (one === null) return { value: null };
      return /^\d{4}-\d{2}-\d{2}/.test(one) ? { value: one.slice(0, 10) } : bad(`'${one}' is not a date (yyyy-mm-dd)`);
    case 'option':
    case 'version': {
      if (one === null) return { value: null };
      const found = optionOf(field, one);
      if (!found) return bad(`'${one}' is not one of ${field?.name ?? pairJira}'s options in Jira (${(field?.allowedValues ?? []).map((allowed) => allowed.value ?? allowed.name).join(', ')})`);
      if (found.id) return { value: { id: found.id } };
      return { value: type === 'version' ? { name: one } : { value: one } };
    }
    case 'array': {
      if (items === 'string') {
        const spaced = list.find((label) => /\s/.test(label));
        return spaced ? bad(`a Jira label holds no space ('${spaced}')`) : { value: list };
      }
      if (items === 'option' || items === 'version' || items === 'component') {
        const out: unknown[] = [];
        for (const item of list) {
          const found = optionOf(field, item);
          if (!found) return bad(`'${item}' is not one of ${field?.name ?? pairJira}'s options in Jira`);
          if (found.id) out.push({ id: found.id });
          else out.push(items === 'option' ? { value: item } : { name: item });
        }
        return { value: out };
      }
      return { kept: `a ${items ?? 'list'} list is not sent by a sync` };
    }
    default:
      return { kept: `a ${type} field is not sent by a sync` };
  }
}

// ---- the status, through Jira's transitions -------------------------------------------------

// The Jira statuses of an issue type that a Backlog status reads as.
function statusesFor(context: Context, board: BoardSettings, type: JiraType | null, wanted: string): string[] {
  return (type?.statuses ?? []).filter((status) => same(statusFor(context.connection.mapping, board, status.name, status.category), wanted)).map((status) => status.name);
}

function statusOut(context: Context, board: BoardSettings, read: Read, wanted: string, options: SyncOptions, side: string): { plan?: StatusPlan; blocker?: Blocker } {
  const current = read.issue.fields.status?.name ?? '';
  const targets = statusesFor(context, board, read.type, wanted);
  const transitions = read.issue.transitions ?? [];
  const name = context.connection.name;
  if (targets.length === 0)
    return {
      blocker: {
        side,
        code: 'unmapped',
        message: `no Jira status of ${read.type?.name ?? 'this issue type'} reads as ${wanted}`,
        fix: `eidos jira configure:map ${name} set statuses "<Jira status>" "${wanted}", or take Jira's status (--take status=jira)`,
      },
    };
  const preferred = options.statusTo ?? context.connection.mapping.statuses?.find((pair) => pair.push === true && same(pair.eidos, wanted))?.jira;
  if (preferred && !targets.some((target) => same(target, preferred)))
    return { blocker: { side, code: 'unmapped', message: `${preferred} does not read as ${wanted} in this root's mapping`, fix: `choose one of ${targets.join(', ')}` } };
  // the status a sync may go to on its own: the one the mapping or the person names, else the Jira status of the same
  // name, else the one Jira status that reads as it; several that a category folds together (Done, Live, Canceled) are
  // never chosen among unasked, since each says something different about the work
  const sameName = targets.find((target) => same(target, wanted));
  const goal = preferred ? [preferred] : sameName ? [sameName] : targets;
  const choose = !preferred && !sameName && targets.length > 1;
  // the walk the person named, then the one transition into a status that reads as the one asked for
  const via = options.via ?? [];
  const first = via[0] ?? null;
  if (first) {
    const hop = transitions.find((transition) => same(transition.to.name, first));
    if (!hop)
      return {
        blocker: {
          side,
          code: 'unreachable',
          message: `${current} has no transition to ${first}`,
          fix: `from ${current} Jira goes to ${nextOf(transitions).join(', ') || 'nowhere'}`,
          ask: { kind: 'via', choices: nextOf(transitions) },
        },
      };
    const last = preferred ?? sameName ?? (targets.length === 1 ? targets[0]! : null);
    if (!last)
      return {
        blocker: {
          side,
          code: 'ambiguous',
          message: `${wanted} is ${targets.join(' or ')} in Jira`,
          fix: `--status-to "<one of ${targets.join(', ')}>", or eidos jira configure:map ${name} set statuses "<Jira status>" "${wanted}" --push`,
          ask: { kind: 'status_to', choices: targets },
        },
      };
    return withFields(context, { from: current, to: last, path: [...via, last], fields: {} }, hop, options, side, read.issue);
  }
  // one transition per status it reaches, the one with no screen first (CTV's Intake reaches To Do by two)
  const byStatus = new Map<string, Transition>();
  for (const transition of transitions) {
    if (!goal.some((target) => same(target, transition.to.name))) continue;
    const key = transition.to.name.toLowerCase();
    const held = byStatus.get(key);
    if (!held || (held.hasScreen === true && transition.hasScreen !== true)) byStatus.set(key, transition);
  }
  const reachable = [...byStatus.values()];
  if (choose && reachable.length > 0) {
    const names = reachable.map((transition) => transition.to.name);
    return {
      blocker: {
        side,
        code: 'ambiguous',
        message: `${wanted} is ${targets.join(' or ')} in Jira; from ${current} the sync can go to ${names.join(' or ')}`,
        fix: `--status-to "<one of ${names.join(', ')}>", or eidos jira configure:map ${name} set statuses "<Jira status>" "${wanted}" --push to settle it for every sync`,
        ask: { kind: 'status_to', choices: names },
      },
    };
  }
  // the goal is one status here, so one transition at most reaches it
  const hop = reachable[0];
  if (hop) return withFields(context, { from: current, to: hop.to.name, path: [hop.to.name], fields: {} }, hop, options, side, read.issue);
  return {
    blocker: {
      side,
      code: 'unreachable',
      message: `${current} has no transition to ${goal.join(' or ')}`,
      fix: `--via "<status>[,<status>]" to walk there; from ${current} Jira goes to ${nextOf(transitions).join(', ') || 'nowhere'}`,
      ask: { kind: 'via', choices: nextOf(transitions) },
    },
  };
}

// The statuses one transition from where the issue is, once each.
const nextOf = (transitions: Transition[]): string[] => [...new Set(transitions.map((transition) => transition.to.name))];

// The fields a transition's screen asks for: the person's --field, else the mapping's transition_fields for that status.
function withFields(context: Context, plan: StatusPlan, hop: Transition, options: SyncOptions, side: string, issue: Issue): { plan?: StatusPlan; blocker?: Blocker } {
  const fields = transitionValues(context, hop, options, issue);
  if ('blocker' in fields) return { blocker: { ...fields.blocker, side } };
  return { plan: { ...plan, fields: fields.values } };
}

// A person a transition's screen asks for, by the root user or the name given, made their Jira account when it is sent.
export interface PersonValue {
  person: string;
}

// What a transition's screen is sent: each field the person or the mapping gives a value for, and every field it
// requires that the issue does not hold already (CTV's Started Work asks for an assignee), which stops the sync until given.
function transitionValues(context: Context, hop: Transition, options: SyncOptions, issue: Issue | null): { values: Record<string, unknown> } | { blocker: Blocker } {
  const given = { ...(context.connection.mapping.transition_fields?.[hop.to.name] ?? {}), ...(options.transitionFields ?? {}) };
  const values: Record<string, unknown> = {};
  for (const [id, field] of Object.entries(hop.fields ?? {})) {
    const value = given[id] ?? (field.name ? given[field.name] : undefined);
    if (value === undefined) {
      const held = issue ? normalise(rawOf(issue.fields[id])) : null;
      if (field.required && !field.hasDefaultValue && held === null) {
        if (field.schema?.type === 'user')
          return {
            blocker: {
              side: 'status',
              code: 'required',
              message: `the transition to ${hop.to.name} asks for ${field.name ?? id}, which the issue does not have`,
              ask: { kind: 'field', field: id, choices: [] },
              fix: `assign the task and sync again, or --field ${id}=<person>`,
            },
          };
        const allowed = (field.allowedValues ?? []).map((held) => held.name ?? held.value).filter(Boolean);
        return {
          blocker: {
            side: 'status',
            code: 'required',
            message: `the transition to ${hop.to.name} asks for ${field.name ?? id}`,
            ask: { kind: 'field', field: id, choices: allowed.filter((value): value is string => typeof value === 'string') },
            fix: `--field ${id}="<${allowed.length > 0 ? allowed.join(' | ') : 'value'}>", or eidos jira configure:map ${context.connection.name} set transition_fields "${hop.to.name}" ${id}="<value>"`,
          },
        };
      }
      continue;
    }
    if (field.schema?.type === 'user') {
      values[id] = { person: value } satisfies PersonValue;
      continue;
    }
    const allowed = field.allowedValues?.find((held) => same(held.name ?? held.value ?? '', value));
    if (field.allowedValues && !allowed)
      return {
        blocker: {
          side: 'status',
          code: 'value',
          message: `'${value}' is not one of ${field.name ?? id}'s values (${field.allowedValues.map((held) => held.name ?? held.value).join(', ')})`,
          fix: `--field ${id}="<one of them>"`,
        },
      };
    values[id] = allowed?.id ? { id: allowed.id } : allowed?.name ? { name: allowed.name } : value;
  }
  return { values };
}

// ---- comments ----------------------------------------------------------------------------

const threadIdOf = (issueId: string): string => `t-jira-${issueId}`;

// The person's own messages in the issue's thread that Jira does not hold yet: those signed by the root user who is the
// Jira account the token signs in as (the mapping's users, else the root user of its name), since a comment Jira is sent
// is that account's, whoever wrote it.
function ownMessages(context: Context, task: TaskView, issueId: string): { thread: ThreadView | null; messages: CommentPlan[] } {
  if (!context.comments || !task.id) return { thread: null, messages: [] };
  const thread = context.comments.threads({ host: 'backlog', id: task.id }).find((held) => held.id === threadIdOf(issueId)) ?? null;
  if (!thread) return { thread: null, messages: [] };
  // the account's root user alone when the root has one; else a message signed with the account's Jira name; only with
  // no account known (a context made without one), whoever signs here
  const account = context.me ? peopleFor(context, false).of(context.me) : null;
  const signer = context.comments.author();
  const mine = (message: { author: string; user?: string }): boolean => {
    if (account?.user) return message.user?.toLowerCase() === account.user.toLowerCase();
    if (context.me) return !message.user && same(message.author, context.me.displayName ?? '');
    return signer.user ? message.user === signer.user : same(message.author, signer.name);
  };
  return {
    thread,
    messages: thread.messages.flatMap((message, index) => (!message.external && mine(message) ? [{ index, text: message.text }] : [])),
  };
}

// ---- the journal (Jira Sync REQ6) ---------------------------------------------------------------

const journalFile = (workspace: string, issueId: string): string => path.join(workspace, 'local', 'sync', `${issueId}.json`);

export function journalOf(workspace: string, issueId: string): { at: string; key: string; steps: string[] } | null {
  const file = journalFile(workspace, issueId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { at: string; key: string; steps: string[] };
  } catch {
    return null;
  }
}

function writeJournal(context: Context, issueId: string, journal: { at: string; key: string; steps: string[] }): void {
  const file = journalFile(context.host.workspace, issueId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`);
}

// ---- the run ------------------------------------------------------------------------------

export interface Prepared {
  plan: SyncPlan;
  task: TaskView;
  held: Held;
  read: Read;
  // per side: the value to send and Jira's own value now, for the guard
  outgoing: Map<string, { jira: string; value: unknown; remoteNow: string }>;
  fromJira: TaskFields;
  // the sides taken from Jira, settled with the task, and settled without a write
  pulledSides: string[];
  sameSides: string[];
  intendedNow: TaskFields;
  ranks: string[];
  options: SyncOptions;
  // the issue type's pairs as the sync compares them, and the fields several sections are mapped to
  pairs: Pair[];
  bundles: Bundle[];
}

// A task by its id or name, or by its issue's key.
export function taskFor(backlog: BacklogApi, ref: string): TaskView {
  const wanted = ref.trim().toLowerCase();
  const tasks = backlog.tasks();
  const found = tasks.find((task) => task.id?.toLowerCase() === wanted || task.name.toLowerCase() === wanted) ?? tasks.find((task) => heldOf(task)?.key.toLowerCase() === wanted) ?? null;
  if (!found) throw new SyncRefused(`no task ${ref} in this root`);
  return found;
}

export async function prepare(context: Context, task: TaskView, options: SyncOptions = {}): Promise<Prepared> {
  const { connection, backlog } = context;
  if (skipOf(task)) throw new SyncRefused(`${task.id ?? task.name} is marked Don't sync; eidos jira skip ${task.id ?? task.name} --off syncs it again`);
  const held = heldOf(task);
  if (!held) throw new SyncRefused(`${task.id ?? task.name} holds no Jira issue; eidos jira create makes one from it`);
  if (siteKey(held.site) !== siteKey(connection.site)) throw new SyncRefused(`${task.id ?? task.name} holds an issue on ${held.site}, not ${connection.name}'s site`);
  if (held.pending) throw new SyncRefused(`${task.id ?? task.name} is waiting on a create that did not finish; eidos jira create ${task.id ?? task.name} finds its issue`);
  const board = backlog.settings();
  const pairs = fieldsOf(connection, board);
  const fetched = await readIssue(context, held.id, pairs);
  const read: Read = { issue: fetched, whole: fetched, type: null };
  const jiraType = read.issue.fields.issuetype?.name ?? '';
  const described = await description(context);
  read.type = described.types.find((type) => same(type.name, jiraType)) ?? null;
  const ranks = connection.mapping.priorities === undefined ? described.priorities : [];
  const type = typeFor(connection.mapping, board, jiraType);
  if (type === null) throw new SyncRefused(`${read.issue.key} is a ${jiraType}, a type ${connection.name}'s mapping does not carry`);
  const typePairs = fieldsFor(pairs, jiraType);
  const bundles = bundlesOf(typePairs);
  const issuePairs = partPairs(typePairs, bundles);
  const split = splitIssue(fetched, bundles, board);
  read.issue = split.issue;
  const people = peopleFor(context, false);
  const adf = adfFor(context, read.issue, task, people);
  // a parent counts as carried when its task is here, so the parent pair reads as a pull does
  const carried = new Set(backlog.tasks().flatMap((other) => (heldOf(other) ? [heldOf(other)!.id] : [])));
  const intended = intendFields(connection, board, read.issue, type, issuePairs, people, adf, carried, ranks);
  const parentTask = intended.parentIssue ? backlog.tasks().find((other) => heldOf(other)?.id === intended.parentIssue) : undefined;
  const intendedNow: TaskFields = { ...intended.fields, parent: parentTask ? (parentTask.id ?? parentTask.name) : null };
  const editmeta = read.issue.editmeta?.fields ?? {};

  const plan: SyncPlan = {
    task: task.id ?? task.name,
    key: read.issue.key,
    url: `${siteBase(connection.site)}/browse/${read.issue.key}`,
    connection: connection.name,
    fields: [],
    status: null,
    comments: [],
    blockers: [],
    loss: {},
    level: true,
  };
  const outgoing = new Map<string, { jira: string; value: unknown; remoteNow: string }>();
  const fromJira: TaskFields = {};
  const pulledSides: string[] = [];
  const sameSides: string[] = [];
  const take = (side: string): 'jira' | 'eidos' | undefined => options.take?.[side] ?? options.take?.['all'];
  // a section of a bundled field to send waits for the others, since the field is written once from them all
  const bundledOut: Array<{ side: string; entry: FieldPlan; remoteNow: string }> = [];
  const send = (side: string, jira: string, out: Outgoing & { status?: StatusPlan }, remoteNow: string, entries: FieldPlan[]): void => {
    if (out.kept) {
      for (const entry of entries) {
        entry.kept = true;
        entry.reason = out.kept;
      }
    } else if (out.blocker) plan.blockers.push(out.blocker);
    else if (out.status) plan.status = out.status;
    else {
      outgoing.set(side, { jira, value: out.value, remoteNow });
      if (out.lost && out.lost.length > 0) {
        plan.loss[side] = out.lost;
        if (!(options.acceptLoss ?? []).some((agreed) => agreed === side || agreed === 'all'))
          plan.blockers.push({
            side,
            code: 'loss',
            message: `writing ${side} takes out of Jira what markdown cannot hold: ${out.lost.map((lost) => `${lost.count} ${lost.kind}`).join(', ')}`,
            fix: `--accept-loss ${side}, or make the change in Jira and take Jira's (--take ${side}=jira)`,
          });
      }
    }
  };

  for (const pair of issuePairs) {
    const side = pair.eidos;
    const localValue = side === 'parent' ? (task.parent ?? null) : heldValue(task, side);
    const remoteValue = side === 'parent' ? (intendedNow.parent ?? null) : intendedValue(intendedNow, side);
    // a parent is recorded by its issue's id, as a pull records it: the task's parent by the issue its task holds
    const parentIssueOf = (ref: string | null): string | null => {
      if (!ref) return null;
      const parent = backlog.tasks().find((other) => (other.id ?? other.name).toLowerCase() === ref.toLowerCase());
      return (parent ? heldOf(parent)?.id : null) ?? `task:${ref.toLowerCase()}`;
    };
    const local = side === 'parent' ? short(parentIssueOf(task.parent)) : short(normalise(localValue));
    const mapped = side === 'parent' ? short(intended.parentIssue) : short(normalise(remoteValue));
    const base = held.digest?.[side];
    const remoteBase = held.remote?.[side];
    const remoteNow = remoteOf(read.issue, pair);
    const changedHere = base === undefined ? local !== mapped : local !== base;
    // Jira's own value against its own base; a task pulled before the remote base was kept is read by the mapped value,
    // and a change the mapping folds away cannot be seen there, so a field changed here is put to the person
    const recorded = remoteBase !== undefined;
    // a section Jira's text has no heading for is unchanged there, which needs no record of Jira's side (Jira Sync REQ17)
    const absentThere = split.absent.has(side);
    const changedThere = absentThere ? false : recorded ? remoteNow !== remoteBase : base === undefined ? local !== mapped : mapped !== base;
    const owner = syncOf(pair);
    const entry: FieldPlan = { side, jira: pair.jira, verdict: 'unchanged', eidos: shown(localValue), remote: shown(remoteValue), seen: remoteNow };
    if (side.startsWith('section:')) entry.text = { eidos: String(localValue ?? '').trim(), remote: String(remoteValue ?? '').trim() };
    let verdict: Verdict;
    if (!changedHere && !changedThere) verdict = 'unchanged';
    else if (local === mapped) verdict = 'same';
    else if (!changedHere) verdict = owner === 'push' ? 'conflict' : 'from-jira';
    else if (!changedThere && (recorded || absentThere)) verdict = owner === 'pull' ? 'conflict' : 'to-jira';
    else verdict = 'conflict';
    if (verdict === 'conflict') {
      if (!changedHere && owner === 'push') entry.reason = `Jira changed ${side}, a field the root owns`;
      else if (owner === 'pull' && !changedThere) entry.reason = `${side} changed here, but the mapping takes it from Jira alone`;
      else if (!recorded && !changedThere) entry.reason = "Jira's own value was not recorded at the last pull, so a change there cannot be ruled out";
      else entry.reason = 'changed in both places';
    }
    if (verdict === 'conflict') {
      const chosen = take(side);
      if (chosen === 'jira') verdict = 'from-jira';
      else if (chosen === 'eidos') verdict = 'to-jira';
    }
    // a value sent as Jira already holds it is the same text, settled without a write
    if (verdict === 'to-jira' && side.startsWith('section:') && canonicalText(String(localValue ?? '')) === canonicalText(String(remoteValue ?? ''))) verdict = 'same';
    entry.verdict = verdict;
    const expected = options.expect?.[side];
    if (expected !== undefined && expected !== remoteNow && verdict !== 'unchanged' && verdict !== 'same') {
      plan.blockers.push({
        side,
        code: 'conflict',
        message: `${side}: Jira changed it after the plan you confirmed; in Jira now ${entry.remote}`,
        fix: 'review the sync again',
      });
      entry.reason = 'changed in Jira since the plan was shown';
      verdict = 'conflict';
      entry.verdict = verdict;
      plan.fields.push(entry);
      continue;
    }
    if (verdict === 'conflict') {
      plan.blockers.push({
        side,
        code: !recorded && !changedThere ? 'unrecorded' : 'conflict',
        message: `${side}: ${entry.reason}; here ${entry.eidos}, in Jira ${entry.remote}`,
        fix: `--take ${side}=jira or --take ${side}=eidos`,
      });
    }
    if (verdict === 'from-jira') {
      pulledSides.push(side);
      copySide(fromJira, intendedNow, side);
    }
    if (verdict === 'same') sameSides.push(side);
    if (verdict === 'to-jira') {
      if (bundles.some((bundle) => bundle.sides.includes(side))) bundledOut.push({ side, entry, remoteNow });
      else send(side, pair.jira, await outgoingFor(context, board, read, pair, editmeta, localValue, adf, options, side, ranks), remoteNow, [entry]);
    }
    plan.fields.push(entry);
  }

  // each bundled field with a section to send is written once: the task's text for a section sent, Jira's own part for
  // the rest, so a part nobody changed goes back as Jira holds it (Jira Sync REQ17)
  for (const bundle of bundles) {
    const sending = bundledOut.filter((held) => bundle.sides.includes(held.side));
    if (sending.length === 0) continue;
    const values = Object.fromEntries(bundle.sides.map((side) => [side, String((sending.some((held) => held.side === side) ? heldValue(task, side) : intendedValue(intendedNow, side)) ?? '')]));
    const first = issuePairs.find((pair) => pair.eidos === bundle.sides[0])!;
    const out = await outgoingFor(
      context,
      board,
      { ...read, issue: read.whole },
      { ...first, jira: bundle.field },
      editmeta,
      composeText(bundle, values, board),
      adf,
      options,
      sending[0]!.side,
      ranks,
    );
    send(
      sending[0]!.side,
      bundle.field,
      out,
      sending[0]!.remoteNow,
      sending.map((held) => held.entry),
    );
    // every section sent is written by that one value, each with its own part's base for the guard
    const value = outgoing.get(sending[0]!.side);
    if (value) for (const held of sending.slice(1)) outgoing.set(held.side, { jira: bundle.field, value: value.value, remoteNow: held.remoteNow });
  }

  if (!options.noComments) {
    const { messages } = ownMessages(context, task, held.id);
    plan.comments = messages;
  }
  plan.level = plan.fields.every((field) => field.verdict === 'unchanged') && plan.comments.length === 0;
  return { plan, task, held, read, outgoing, fromJira, pulledSides, sameSides, intendedNow, ranks, options, pairs: issuePairs, bundles };
}

export function copySide(target: TaskFields, from: TaskFields, side: string): void {
  const [head, name = ''] = side.split(/:(.*)/s);
  if (head === 'section') target.sections = { ...(target.sections ?? {}), [name]: from.sections?.[name] ?? '' };
  else if (head === 'property') target.properties = { ...(target.properties ?? {}), [name]: from.properties?.[name] ?? null };
  else if (head === 'title' || head === 'type' || head === 'status' || head === 'priority' || head === 'assignee' || head === 'milestone' || head === 'parent')
    (target as Record<string, unknown>)[head] = (from as Record<string, unknown>)[head] ?? null;
}

async function outgoingFor(
  context: Context,
  board: BoardSettings,
  read: Read,
  pair: Pair,
  editmeta: Record<string, EditField>,
  localValue: unknown,
  adf: AdfContext,
  options: SyncOptions,
  side: string,
  ranks: string[],
): Promise<Outgoing & { status?: StatusPlan }> {
  const [head] = side.split(':');
  if (['key', 'creator', 'reporter', 'created', 'updated', 'resolutiondate', 'resolution'].includes(pair.jira)) return { kept: `Jira sets ${pair.jira} and never takes it` };
  if (head === 'status') {
    const status = statusOut(context, board, read, String(localValue ?? ''), options, side);
    return status.blocker ? { blocker: status.blocker } : { status: status.plan! };
  }
  if (head === 'type') return { kept: "a Jira issue's type is changed by moving it in Jira" };
  if (head === 'parent') return { kept: "a Jira issue's parent is changed in Jira" };
  if (head === 'milestone') return { kept: 'a sprint is planned on the Jira board' };
  const field = editmeta[pair.jira];
  if (!field) return { kept: `${pair.jira} is not on ${read.issue.key}'s edit screen in Jira` };
  if (head === 'priority') return priorityOut(context, board, field, read.issue.fields.priority, (localValue as string | null) ?? null, side, ranks);
  if (head === 'assignee') {
    const people = Array.isArray(localValue) ? (localValue as string[]) : [];
    if (people.length > 1) return { blocker: { side, code: 'value', message: `a Jira issue has one assignee; the task has ${people.join(', ')}`, fix: 'keep one assignee on the task' } };
    if (people.length === 0) return { value: null };
    const found = await accountFor(context, { issueKey: read.issue.key }, people[0]!, side);
    return found.blocker ? { blocker: found.blocker } : { value: { accountId: found.accountId } };
  }
  if (head === 'title') return valueOut(context, pair.jira, field, localValue, read.issue.fields[pair.jira], adf, side);
  return valueOut(context, pair.jira, field, localValue, read.issue.fields[pair.jira], adf, side);
}

// The plan carried out (Jira Sync REQ5, REQ6): the task first with what came from Jira, then Jira, then the bases settled
// from what Jira holds once it answered. A field whose base is not settled reads as changed at the next sync, so a run
// cut short leaves nothing marked done that is not.
export async function apply(context: Context, prepared: Prepared): Promise<SyncDone> {
  const { plan, held, read, outgoing } = prepared;
  if (plan.blockers.length > 0) throw new SyncRefused(`${plan.key} is not synced: ${plan.blockers.map((blocker) => blocker.message).join('; ')}`);
  const { backlog, client } = context;
  const name = prepared.task.id ?? prepared.task.name;
  const done: SyncDone = { task: name, key: plan.key, to_jira: [], from_jira: [...prepared.pulledSides], settled: [...prepared.sameSides], status: null, comments: 0, kept_by_jira: [] };
  const steps = [...outgoing.keys(), ...(plan.status ? [`status → ${plan.status.path.join(' → ')}`] : []), ...plan.comments.map((comment) => `comment ${comment.index}`)];
  const journal = { at: new Date().toISOString(), key: plan.key, run: randomUUID(), steps };
  if (steps.length > 0) writeJournal(context, held.id, journal);

  // 1. what Jira changed, into the task; those bases and the ones already level settled now, a pushed side's left as they were
  const pairs = prepared.pairs;
  const board = backlog.settings();
  const seen = (issue: Issue): Issue => splitIssue(issue, prepared.bundles, board).issue;
  const digest = { ...(held.digest ?? {}) };
  const remote = { ...(held.remote ?? {}) };
  const settle = (written: TaskView, sides: string[], issue: Issue): void => {
    for (const side of sides) {
      const pair = pairs.find((held) => held.eidos === side);
      if (!pair) continue;
      digest[side] = side === 'parent' ? short(issue.fields.parent?.id ?? null) : short(normalise(heldValue(written, side)));
      remote[side] = remoteOf(issue, pair);
    }
  };
  let written = backlog.set(name, { ...prepared.fromJira, tool: { jira: { ...held } } });
  settle(written, [...prepared.pulledSides, ...prepared.sameSides], read.issue);
  written = backlog.set(name, { tool: { jira: { ...held, digest: sorted(digest), remote: sorted(remote) } } });

  if (steps.length === 0) return done;

  // 2. the guard: Jira read again just before it is written; a pushed field it changed meanwhile stops the sync
  const guard = await client.get<Issue>(`/rest/api/3/issue/${encodeURIComponent(held.id)}`, { fields: ['updated', 'status', ...[...outgoing.values()].map((out) => out.jira)].join(',') });
  if (guard.fields.updated !== read.issue.fields.updated) {
    const moved = [...outgoing]
      .filter(
        ([side, out]) =>
          remoteOf(
            seen(guard),
            pairs.find((pair) => pair.eidos === side)!,
          ) !== out.remoteNow,
      )
      .map(([side]) => side);
    const statusMoved = plan.status !== null && guard.fields.status?.name !== read.issue.fields.status?.name;
    if (moved.length > 0 || statusMoved) {
      rmSync(journalFile(context.host.workspace, held.id), { force: true });
      throw new SyncRefused(`${plan.key} changed in Jira while it was being synced (${[...moved, ...(statusMoved ? ['status'] : [])].join(', ')}); sync it again to see the change`);
    }
  }

  // 3. Jira: the fields in one edit, then the status hop by hop, then the person's messages
  if (outgoing.size > 0) {
    const fields = Object.fromEntries([...outgoing.values()].map((out) => [out.jira, out.value]));
    await client.put(`/rest/api/3/issue/${encodeURIComponent(held.id)}`, { fields });
    done.to_jira.push(...outgoing.keys());
  }
  if (plan.status) {
    for (const [at, target] of plan.status.path.entries()) {
      const now = await client.get<Issue & { transitions?: Transition[] }>(`/rest/api/3/issue/${encodeURIComponent(held.id)}`, { fields: '*navigable', expand: 'transitions.fields' });
      const hop = (now.transitions ?? []).find((transition) => same(transition.to.name, target));
      if (!hop) throw new SyncRefused(`${plan.key} reached ${plan.status.path.slice(0, at).join(' → ') || plan.status.from} but has no transition to ${target}; sync it again to go on`);
      const values = at === 0 ? { values: plan.status.fields } : transitionValues(context, hop, prepared.options, now);
      if ('blocker' in values) throw new SyncRefused(`${plan.key} reached ${hop.name}'s screen, which asks for what the sync was not given: ${values.blocker.message} (${values.blocker.fix})`);
      const fields: Record<string, unknown> = {};
      for (const [id, value] of Object.entries(values.values)) {
        if (typeof value === 'object' && value !== null && 'person' in value) {
          const found = await accountFor(context, { issueKey: plan.key }, String((value as PersonValue).person), 'status');
          if (found.blocker) throw new SyncRefused(`${plan.key}: ${found.blocker.message} (${found.blocker.fix})`);
          fields[id] = { accountId: found.accountId };
        } else fields[id] = value;
      }
      try {
        await client.post(`/rest/api/3/issue/${encodeURIComponent(held.id)}/transitions`, { transition: { id: hop.id }, ...(Object.keys(fields).length > 0 ? { fields } : {}) });
      } catch (cause) {
        // a workflow's validator says what a screen did not (an assignee it requires); the sync stops, and says so, with
        // what was sent before it kept and its base left, so the next sync sees the rest still to send
        if (cause instanceof JiraError && cause.status === 400)
          throw new SyncRefused(
            `Jira refused to move ${plan.key} to ${target}: ${cause.message.replace(/^.*answered 400: /, '')}${done.to_jira.length > 0 ? ` (${done.to_jira.join(', ')} already sent)` : ''}`,
          );
        throw cause;
      }
    }
    done.status = plan.status.to;
    done.to_jira.push('status');
  }
  if (plan.comments.length > 0) {
    const existing = await context.client.get<{ comments?: JiraCommentHeld[] }>(`/rest/api/3/issue/${encodeURIComponent(held.id)}/comment`, { maxResults: 100, orderBy: '-created' });
    done.comments = await sendComments(context, written, held.id, plan, existing.comments ?? []);
  }

  // 4. read back: a side Jira now holds as the task has it is settled; one it kept otherwise is said, its base left
  const after = seen(await readIssue(context, held.id, pairs));
  const people = peopleFor(context, false);
  const adf = adfFor(context, after, written, people);
  const carried = new Set(backlog.tasks().flatMap((other) => (heldOf(other) ? [heldOf(other)!.id] : [])));
  const intendedAfter = intendFields(context.connection, board, after, written.type, pairs, people, adf, carried, prepared.ranks).fields;
  written = backlog.get(name);
  const settledSides: string[] = [];
  for (const side of done.to_jira) {
    const local = short(normalise(heldValue(written, side)));
    const jiraNow = short(normalise(intendedValue(intendedAfter, side)));
    const textSame = side.startsWith('section:') && canonicalText(String(heldValue(written, side) ?? '')) === canonicalText(String(intendedValue(intendedAfter, side) ?? ''));
    if (local === jiraNow || textSame) settledSides.push(side);
    else done.kept_by_jira.push({ side, value: shown(intendedValue(intendedAfter, side)) });
  }
  for (const side of settledSides) {
    const pair = pairs.find((held) => held.eidos === side);
    if (!pair) continue;
    digest[side] = short(normalise(heldValue(written, side)));
    remote[side] = remoteOf(after, pair);
  }
  // the pull's own `updated` is kept as it was: a later pull still reads the issue, since what others changed alongside
  // this sync (a comment, a link) is the pull's to bring in, and finds the fields this sync settled level
  backlog.set(name, { tool: { jira: { ...heldOf(written)!, key: after.key, ...(held.updated ? { updated: held.updated } : {}), digest: sorted(digest), remote: sorted(remote) } } });
  rmSync(journalFile(context.host.workspace, held.id), { force: true });
  return done;
}

const sorted = (record: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

// Each of the person's messages sent as a Jira comment, then taken in as the comment it now is, so the next pull reads it
// as pulled and never adds it twice. A message whose comment is in Jira but was not taken in (a run cut short) is
// found by the next pull by its author and text (Jira Sync REQ11).
async function sendComments(context: Context, task: TaskView, issueId: string, plan: SyncPlan, existing: JiraCommentHeld[]): Promise<number> {
  const comments = context.comments!;
  const threadId = threadIdOf(issueId);
  let sent = 0;
  for (const planned of [...plan.comments].sort((a, b) => a.index - b.index)) {
    // found again by its text, since the messages before it moved as each was taken in
    const thread = comments.thread(threadId);
    const index = thread.messages.findIndex((message) => !message.external && message.text === planned.text);
    if (index < 0) continue;
    const held = thread.messages[index]!;
    // one this account already sent with this text (a sync cut short after Jira took it) is taken in, never sent again
    const already = existing.find((comment) => comment.author?.accountId === context.me?.accountId && adfToMarkdown(comment.body).trim() === held.text.trim());
    const comment =
      already ??
      (await context.client.post<{ id: string; created: string }>(`/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, {
        body: markdownToAdf(held.text),
        properties: [{ key: 'eidos', value: { task: task.id ?? task.name } }],
      }));
    if (!already) sent += 1;
    // taken in at once, so a failure on the next one leaves this one known as sent
    const author = { name: held.author, role: (held as { role?: string }).role ?? null, user: held.user ?? null };
    const origin = { written: comment.created, external: `jira:${comment.id}` };
    comments.removeMessage(threadId, index);
    const still = comments.threads({ host: 'backlog', id: task.id! }).find((candidate) => candidate.id === threadId);
    if (still) comments.reply(still.id, held.text, author, origin);
    else comments.start({ host: 'backlog', id: task.id! }, null, held.text, author, { ...origin, thread: threadId });
  }
  return sent;
}

interface JiraCommentHeld {
  id: string;
  created: string;
  author?: { accountId?: string };
  body?: unknown;
}

// One comment sent to a task's issue now, signed in the root by the root user the token's account is, and kept in the
// issue's thread as the comment it became (Jira Sync REQ11): the way to comment on an issue the root has no thread for yet.
export async function sendComment(context: Context, task: TaskView, text: string): Promise<{ key: string; id: string }> {
  const held = heldOf(task);
  if (!held) throw new SyncRefused(`${task.id ?? task.name} holds no Jira issue`);
  const comments = context.comments;
  if (!comments || !task.id) throw new SyncRefused('the Comments plugin is off, so the comment would have nowhere to stay here');
  if (text.trim() === '') throw new SyncRefused('a comment needs its text');
  const account = context.me ? peopleFor(context, false).of(context.me) : null;
  // signed as the pull signs this account's comments: its root user, else the name Jira gives it
  const signer = (account?.user ? comments.authorAs(account.user) : null) ?? (context.me?.displayName ? { name: context.me.displayName, role: null, user: null } : comments.author());
  const comment = await context.client.post<{ id: string; created: string }>(`/rest/api/3/issue/${encodeURIComponent(held.id)}/comment`, {
    body: markdownToAdf(text),
    properties: [{ key: 'eidos', value: { task: task.id } }],
  });
  const origin = { written: comment.created, external: `jira:${comment.id}` };
  const thread = comments.threads({ host: 'backlog', id: task.id }).find((candidate) => candidate.id === threadIdOf(held.id));
  if (thread) comments.reply(thread.id, text, signer, origin);
  else comments.start({ host: 'backlog', id: task.id }, null, text, signer, { ...origin, thread: threadIdOf(held.id) });
  return { key: held.key, id: comment.id };
}

// The tasks of a connection edited in the root since their last pull or sync, read from the tasks alone (no request to
// Jira): what `eidos jira status` lists and `sync --connection` walks.
export function editedHere(context: Pick<Context, 'backlog' | 'connection'>): Array<{ task: string; key: string; sides: string[] }> {
  const board = context.backlog.settings();
  const pairs = fieldsOf(context.connection, board);
  const site = siteKey(context.connection.site);
  const out: Array<{ task: string; key: string; sides: string[] }> = [];
  for (const task of context.backlog.tasks()) {
    const held = heldOf(task);
    if (!held || siteKey(held.site) !== site || held.gone || skipOf(task)) continue;
    const sides = Object.entries(held.digest ?? {})
      .filter(([side]) => side !== 'type' && side !== 'parent' && pairs.some((pair) => pair.eidos === side))
      .filter(([side, base]) => short(normalise(heldValue(task, side))) !== base)
      .map(([side]) => side);
    if (sides.length > 0) out.push({ task: task.id ?? task.name, key: held.key, sides });
  }
  return out;
}

export { categoryOf };
