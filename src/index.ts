// The Jira plugin's CLI entry (Jira, Jira Pull): `eidos jira` and its
// commands, the `jira/<code>` findings `eidos check` reports, the timer that
// fetches on its own where the app's server runs it, and the API the app's
// half answers through. Built as a CommonJS bundle whose one import from the
// CLI is `eidosmd/plugin`.
import type { CliEntry, FoundProblem, Host } from 'eidosmd/plugin';
import { jiraClient, JiraError, type Credentials } from './client.ts';
import {
  connection as connectionNamed,
  connections,
  credentials,
  heldSignIns,
  MAPPING_PARTS,
  readConnection,
  removeSignIn,
  saveSignIn,
  SCOPE_WORDS,
  signIn,
  signedInSites,
  type Scope,
  siteKey,
  useSignIn,
  writeConnections,
  type Connection,
  type Mapping,
  type MappingPart,
  type Pair,
} from './connections.ts';
import { cachedDescription, keepDescription, readDescription, type Description } from './describe.ts';
import { checkMapping, compactFields, draftMapping, editorModel, type DraftEntry, type EditorModel, type MappingChoice, type MappingProblem, PARENT_RULES } from './mapping.ts';
import { ask, confirm, readLines } from './prompt.ts';
import { create as createIssue, parentsFirst, prepareCreate, type CreateOptions, type CreatePlan, type Created } from './create.ts';
import { heldOf, readState, run, writeState, type Done, type Plan } from './pull.ts';
import { apply as applySync, editedHere, journalOf, prepare as prepareSync, sendComment, SyncRefused, taskFor, type SyncDone, type SyncOptions, type SyncPlan } from './sync.ts';
import { tokensFile } from './tokens.ts';
import type { AssetsApi, BacklogApi, CommentsApi, TaskView } from './types.ts';

export interface JiraApi {
  connections(): Connection[];
  fetch(name?: string): Promise<Plan[]>;
  pull(name?: string, options?: { full?: boolean; keepLocal?: boolean }): Promise<Done[]>;
  // what the Backlog's head says per pull connection: the last fetch's count, or why it failed
  status(): Array<{ connection: string; last_pull: string | null; last_fetch: { at: string; count: number; error?: string } | null }>;
  // The settings page's half (the app entry's routes answer through these, as the commands do)
  // each site this root's connections use or a sign-in names, with who signs in there and where that is kept
  signIns(): SignInRow[];
  login(site: string, email: string, token: string, global: boolean): Promise<{ site: string; email: string; name: string }>;
  logout(site: string, email?: string): Promise<string[]>;
  // every account kept on this machine, and which one is the default and which one this root picked
  heldSignIns(): Array<{ site: string; email: string; default: boolean; picked: boolean }>;
  use(site: string, email: string, global: boolean): Promise<void>;
  connect(input: { name: string; site: string; project: string; board?: string | number; jql?: string; direction?: 'pull' | 'push'; restricted_comments?: boolean }): Promise<Connection>;
  disconnect(name: string): Promise<void>;
  describe(name: string, refresh: boolean): Promise<Description>;
  draft(name: string): Promise<{ entries: DraftEntry[]; unmatched: string[] }>;
  accept(name: string, entries: Array<Pick<DraftEntry, 'part' | 'jira' | 'eidos'>>): Promise<Connection>;
  // a field pair naming issue types takes those types from the field's other pairs, and leaves its untyped pair be
  setPair(
    name: string,
    part: MappingPart | 'parent' | 'transition_fields' | 'create.types' | 'create.fields',
    jira: string,
    eidos: string | null,
    types?: string[],
    marks?: { push?: boolean; owner?: 'jira' | 'eidos' },
  ): Promise<{ connection: Connection; problems: MappingProblem[] }>;
  problems(name: string): MappingProblem[];
  // The mapping editor's half (Jira REQ12): what it draws, the whole mapping it saves, and a property made for a field
  model(name: string, refresh: boolean): Promise<EditorModel>;
  saveMapping(name: string, chosen: MappingChoice): Promise<{ connection: Connection; problems: MappingProblem[] }>;
  addProperty(declaration: { name: string; type: string; options?: string[] }): Promise<void>;
  // Jira Sync: what a sync of one task would do, and doing it once nothing stands in its way
  syncPlan(task: string, options?: SyncOptions): Promise<SyncPlan>;
  sync(task: string, options?: SyncOptions): Promise<SyncDone>;
  comment(task: string, text: string): Promise<{ key: string; id: string }>;
  // the tasks edited here since their last pull or sync, the creates cut short, and the syncs cut short, read from the root alone
  syncStatus(name?: string): SyncStatus[];
  // Jira Push: what creating an issue from each task would send, and creating them once none is stopped
  createPlan(tasks: string[], connection: string, options?: CreateOptions): Promise<CreatePlan[]>;
  create(tasks: string[], connection: string, options?: CreateOptions): Promise<Created[]>;
}

export interface SyncStatus {
  connection: string;
  edited: Array<{ task: string; key: string; sides: string[] }>;
  pending: string[];
  interrupted: Array<{ key: string; at: string }>;
}

export interface SignInRow {
  site: string;
  email: string | null;
  kept: string | null;
  scope: Scope | null;
}

const SETTINGS_PATH = '.eidos/plugins/jira/settings.yaml';

function fail(error: unknown): void {
  process.stderr.write(`eidos jira: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

// A command's action, its failure said on stderr with exit code 1.
const action =
  <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) =>
  async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      fail(error);
    }
  };

const print = (text: string): void => {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
};
const json = (value: unknown): void => print(JSON.stringify(value, null, 2));

function backlogOf(host: Host): BacklogApi {
  const backlog = host.plugin<BacklogApi>('backlog');
  if (!backlog) throw new Error('the Backlog is off for this root; Jira pulls issues into it (eidos plugin enable backlog)');
  return backlog;
}

async function contextFor(host: Host, connection: Connection, given?: Credentials) {
  const client = jiraClient(connection.site, given ?? credentials(host, connection.site), connection.name);
  const me = await client.get<{ timeZone?: string; accountId: string; displayName?: string; emailAddress?: string }>('/rest/api/3/myself');
  return {
    host,
    backlog: backlogOf(host),
    comments: host.plugin<CommentsApi>('comments'),
    assets: host.plugin<AssetsApi>('assets'),
    client,
    connection,
    timeZone: me.timeZone ?? 'UTC',
    pullAttachments: host.settings().get<boolean>('pull_attachments') === true,
    addPeople: host.settings().get<boolean>('add_people') === true,
    me: { accountId: me.accountId, ...(me.displayName ? { displayName: me.displayName } : {}), ...(me.emailAddress ? { emailAddress: me.emailAddress } : {}) },
  };
}

// The connection a linked task syncs through: the one that made its issue, else the one over its issue's project and site.
function connectionOfTask(host: Host, task: TaskView): Connection {
  const held = heldOf(task);
  if (!held) throw new SyncRefused(`${task.id ?? task.name} holds no Jira issue; eidos jira create <task> --connection <name> makes one`);
  if (held.connection) return connectionNamed(host, held.connection);
  const project = held.key.replace(/-\d+$/, '').toUpperCase();
  const found = connections(host).find((entry) => siteKey(entry.site) === siteKey(held.site) && entry.project === project);
  if (!found) throw new SyncRefused(`no connection in this root is over ${project} on ${held.site}; eidos jira connect adds one`);
  return found;
}

const pairsOf = (values: string[] | undefined, what: string): Record<string, string> =>
  Object.fromEntries(
    (values ?? []).map((entry) => {
      const at = entry.indexOf('=');
      if (at <= 0) throw new Error(`${what} is <name>=<value>: '${entry}'`);
      return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()];
    }),
  );

function describeSync(plan: SyncPlan): string {
  const lines = [`${plan.task} ⇄ ${plan.key}  ${plan.url}`];
  const arrows: Record<SyncPlan['fields'][number]['verdict'], string> = { unchanged: ' ', 'from-jira': '←', 'to-jira': '→', same: '=', conflict: '!' };
  const moving = plan.fields.filter((field) => field.verdict !== 'unchanged');
  if (moving.length === 0 && plan.comments.length === 0 && plan.blockers.length === 0) lines.push('  level: nothing to sync');
  for (const field of moving) {
    const what =
      field.verdict === 'from-jira'
        ? `from Jira: ${field.remote}`
        : field.verdict === 'to-jira'
          ? field.kept
            ? `kept here, not sent: ${field.reason}`
            : `to Jira: ${field.eidos}`
          : field.verdict === 'same'
            ? 'the same on both sides, settled'
            : `here ${field.eidos} | Jira ${field.remote}`;
    lines.push(`  ${arrows[field.verdict]} ${field.side.padEnd(22)} ${what}`);
  }
  if (plan.status)
    lines.push(`  → status: ${plan.status.from} → ${plan.status.path.join(' → ')}${Object.keys(plan.status.fields).length > 0 ? ` (${Object.keys(plan.status.fields).join(', ')})` : ''}`);
  for (const comment of plan.comments) lines.push(`  → comment: ${comment.text.replace(/\s+/g, ' ').slice(0, 80)}`);
  for (const [side, lost] of Object.entries(plan.loss)) lines.push(`  ⚠ ${side} drops from Jira: ${lost.map((entry) => `${entry.count} ${entry.kind}`).join(', ')}`);
  for (const blocker of plan.blockers) lines.push(`  ✗ ${blocker.message}\n      fix: ${blocker.fix}`);
  return lines.join('\n');
}

function describeCreate(plan: CreatePlan): string {
  if (plan.recovering) return `${plan.task} → ${plan.project}: a create was cut short; it is looked for by its mark`;
  const lines = [`${plan.task} → a new ${plan.type ?? '?'} in ${plan.project}${plan.parent ? ` under ${plan.parent}` : ''}`];
  for (const field of plan.fields)
    lines.push(`    ${field.jira.padEnd(20)} ${field.value}${field.from === 'task' ? '' : `  (${field.from === 'default' ? "the mapping's create default" : '--field'})`}`);
  if (plan.later.length > 0) lines.push(`    not on the create screen, sent by the first sync: ${plan.later.join(', ')}`);
  for (const blocker of plan.blockers) lines.push(`  ✗ ${blocker.message}\n      fix: ${blocker.fix}`);
  return lines.join('\n');
}

function pullConnections(host: Host, name: string | undefined): Connection[] {
  if (name) {
    const found = connectionNamed(host, name);
    if (found.direction !== 'pull') throw new Error(`${found.name} is a push connection, which pulls nothing; eidos jira create makes issues from tasks`);
    return [found];
  }
  const all = connections(host).filter((entry) => entry.direction === 'pull');
  if (all.length === 0) throw new Error('this root has no pull connection; eidos jira connect adds one');
  return all;
}

// ---- what a fetch and a pull print ------------------------------------------------------

function describePlan(plan: Plan): string {
  const lines: string[] = [];
  const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
  const comments = plan.comments.add + plan.comments.change + plan.comments.remove;
  const head = [
    `${count(plan.add.length, 'issue')} to add`,
    `${count(plan.change.length, 'task')} to change`,
    ...(comments > 0 ? [`comments: ${plan.comments.add} to add, ${plan.comments.change} to change, ${plan.comments.remove} to remove`] : []),
    ...(plan.people.length > 0 ? [`${count(plan.people.length, 'person', 'people')} to add`] : []),
    ...(plan.gone.length > 0 ? [`${plan.gone.length} gone`] : []),
  ];
  const nothing = plan.add.length + plan.change.length + comments + plan.gone.length + plan.people.length + plan.attachments === 0;
  lines.push(`${plan.connection}: ${nothing ? 'nothing to pull' : head.join(', ')}${plan.since ? ` (changed since ${plan.since})` : ' (the whole scope)'}`);
  for (const add of plan.add) lines.push(`  + ${add.key}  ${add.title} (${add.type})`);
  for (const change of plan.change) lines.push(`  ~ ${change.key}  ${change.task}${change.fields.length > 0 ? `: ${change.fields.join(', ')}` : ''}`);
  for (const waiting of plan.waiting ?? []) lines.push(`  … ${waiting.key}  made by ${waiting.task}'s create, cut short; eidos jira create ${waiting.task} links it`);
  for (const owned of plan.owned ?? [])
    lines.push(`  ⇄ ${owned.key}  ${owned.task}: Jira changed ${owned.fields.join(', ')}, which this root owns; the pull leaves them (eidos jira sync ${owned.task} settles it)`);
  for (const local of plan.local) lines.push(`  ! ${local.key}  ${local.task} was edited here: ${local.fields.join(', ')} (a pull overwrites it; --keep-local keeps it)`);
  for (const person of plan.people) lines.push(`  @ ${person}`);
  for (const gone of plan.gone) lines.push(`  - ${gone.key}  ${gone.task} is gone from the scope; its task stays`);
  for (const back of plan.back) lines.push(`  ↺ ${back.key}  ${back.task} is back in the scope`);
  if (plan.milestones.length > 0) lines.push(`  milestones to add: ${plan.milestones.join(', ')}`);
  if (plan.attachments > 0) lines.push(`  ${count(plan.attachments, 'attachment')} to download`);
  const types = Object.entries(plan.left_out.types);
  if (types.length > 0) lines.push(`  left out: ${types.map(([type, n]) => `${n} ${type}`).join(', ')} (types the mapping does not carry)`);
  if (plan.left_out.links > 0) lines.push(`  left out: ${count(plan.left_out.links, 'link')} to issues not pulled or of unmapped types`);
  if (plan.left_out.parents > 0) lines.push(`  left out: ${count(plan.left_out.parents, 'parent')} not pulled`);
  return lines.join('\n');
}

function describeDone(done: Done): string {
  const parts = [`${done.added} added`, `${done.changed} changed`];
  if (done.kept_local > 0) parts.push(`${done.kept_local} kept local edits`);
  const comments = done.comments;
  if (comments.added + comments.changed + comments.removed > 0) parts.push(`comments ${comments.added} added, ${comments.changed} changed, ${comments.removed} removed`);
  if (done.people > 0) parts.push(`${done.people} people added`);
  if (done.gone > 0) parts.push(`${done.gone} marked gone`);
  if (done.attachments > 0) parts.push(`${done.attachments} attachments downloaded`);
  const types = Object.values(done.left_out.types).reduce((sum, n) => sum + n, 0);
  if (types > 0) parts.push(`${types} left out by type`);
  return `${done.connection}: ${parts.join(', ')}`;
}

function describeDescription(description: Description): string {
  const lines = [`${description.connection}, read ${description.read}`];
  if (description.columns.length > 0) {
    lines.push('', 'Board columns');
    for (const column of description.columns) lines.push(`  ${column.name}: ${column.statuses.join(', ') || '(none)'}`);
  }
  lines.push('', 'Issue types');
  for (const type of description.types) {
    lines.push(`  ${type.name}${type.subtask ? ' (sub-task)' : ''}: ${type.statuses.map((status) => `${status.name} [${status.category}]`).join(', ')}`);
    for (const field of type.fields)
      lines.push(`    ${field.id}  ${field.name}  ${field.type}${field.items ? `<${field.items}>` : ''}${field.required ? '  required' : ''}${field.allowed ? `  {${field.allowed.join(', ')}}` : ''}`);
  }
  lines.push('', `Priorities: ${description.priorities.join(', ')}`);
  lines.push(`Link types: ${description.link_types.map((type) => `${type.name} (${type.outward} / ${type.inward})`).join(', ')}`);
  if (description.sprints.length > 0) lines.push(`Sprints: ${description.sprints.map((sprint) => `${sprint.name} [${sprint.state}]`).join(', ')}`);
  return lines.join('\n');
}

// ---- the entry ------------------------------------------------------------------------

const entry: CliEntry = {
  register(host: Host) {
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const description = async (connection: Connection, refresh: boolean): Promise<Description> => {
      const held = cachedDescription(host.workspace, connection.name);
      if (held && !refresh) return held;
      const { client } = await contextFor(host, connection);
      const read = await readDescription(client, connection, (stage) => host.emit('describe', { connection: connection.name, ...stage }));
      keepDescription(host.workspace, read);
      return read;
    };

    const fetchOne = async (connection: Connection): Promise<Plan> => (await run(await contextFor(host, connection), false)).plan;

    const api: JiraApi = {
      connections: () => connections(host),
      fetch: async (name) => {
        const out: Plan[] = [];
        for (const connection of pullConnections(host, name)) out.push(await fetchOne(connection));
        return out;
      },
      pull: async (name, options = {}) => {
        const out: Done[] = [];
        for (const connection of pullConnections(host, name)) out.push((await run(await contextFor(host, connection), true, options)).done!);
        return out;
      },
      status: () =>
        connections(host)
          .filter((entry) => entry.direction === 'pull')
          .map((entry) => {
            const state = readState(host.workspace, entry.name);
            return { connection: entry.name, last_pull: state.last_pull ?? null, last_fetch: state.last_fetch ?? null };
          }),
      signIns: () => {
        const sites = [...new Set([...connections(host).map((entry) => siteKey(entry.site)), ...signedInSites(host)])];
        return sites.map((site) => {
          const found = signIn(host, site);
          return { site, email: found?.email ?? null, kept: found ? SCOPE_WORDS[found.scope] : null, scope: found?.scope ?? null };
        });
      },
      login: async (site, email, token, global) => {
        if (!email.trim() || !token.trim()) throw new Error('an email and a token are both needed');
        const client = jiraClient(site, { email: email.trim(), token: token.trim() }, siteKey(site));
        const me = await client.get<{ displayName?: string }>('/rest/api/3/myself').catch((error: unknown) => {
          if (error instanceof JiraError && error.status === 401) throw new Error(`${siteKey(site)} did not accept that email and token`);
          throw error;
        });
        await saveSignIn(host, site, { email: email.trim(), token: token.trim() }, global);
        return { site: siteKey(site), email: email.trim(), name: me.displayName ?? email.trim() };
      },
      logout: (site, email) => removeSignIn(host, site, email),
      heldSignIns: () => heldSignIns(host),
      use: (site, email, global) => useSignIn(host, site, email.trim(), global),
      connect: async (input) => {
        const made = readConnection({ ...input, direction: input.direction ?? 'pull', mapping: {} });
        if (!made) throw new Error('a connection needs a name, a site, and a project');
        const all = connections(host);
        if (all.some((held) => held.name.toLowerCase() === made.name.toLowerCase())) throw new Error(`a connection called ${made.name} is already here`);
        await writeConnections(host, [...all, made]);
        return made;
      },
      disconnect: async (name) => {
        const found = connectionNamed(host, name);
        await writeConnections(
          host,
          connections(host).filter((held) => held.name !== found.name),
        );
      },
      describe: (name, refresh) => description(connectionNamed(host, name), refresh),
      draft: async (name) => {
        const connection = connectionNamed(host, name);
        return draftMapping(connection, backlogOf(host).settings(), await description(connection, false));
      },
      accept: async (name, entries) => {
        const connection = connectionNamed(host, name);
        const next = { ...connection, mapping: { ...connection.mapping } };
        for (const proposed of entries) {
          const rest = (next.mapping[proposed.part] ?? []).filter((pair) => pair.jira.toLowerCase() !== proposed.jira.toLowerCase());
          next.mapping[proposed.part] = [...rest, { jira: proposed.jira, eidos: proposed.eidos }];
        }
        await writeConnections(
          host,
          connections(host).map((held) => (held.name === connection.name ? next : held)),
        );
        return next;
      },
      setPair: async (name, part, from, to, types = [], marks = {}) => {
        const connection = connectionNamed(host, name);
        const next = { ...connection, mapping: { ...connection.mapping } };
        if (part === 'transition_fields') {
          // a value for one field of the screen a transition to the status `from` shows: `to` is field=value
          if (!from) throw new Error('name the Jira status whose transition screen it is');
          const held = { ...(next.mapping.transition_fields ?? {}) };
          const screen = { ...(held[from] ?? {}) };
          const at = (to ?? '').indexOf('=');
          if (to !== null && at <= 0) throw new Error('a transition field is <field>=<value>');
          if (to === null) delete held[from];
          else {
            screen[to.slice(0, at).trim()] = to.slice(at + 1).trim();
            held[from] = screen;
          }
          next.mapping.transition_fields = held;
        } else if (part === 'create.types' || part === 'create.fields') {
          if (!from) throw new Error(part === 'create.types' ? 'name the Backlog type' : 'name the Jira field');
          const key = part === 'create.types' ? 'types' : 'fields';
          const held = { ...(next.mapping.create?.[key] ?? {}) };
          if (to === null) delete held[from];
          else held[from] = to;
          next.mapping.create = { ...(next.mapping.create ?? {}), [key]: held };
        } else if (part === 'parent') {
          if (to === null) delete next.mapping.parent;
          else if (from === 'subtasks' || from === 'all' || from === 'none') next.mapping.parent = from;
          else throw new Error('parent is subtasks, all, or none');
        } else {
          if (!(MAPPING_PARTS as readonly string[]).includes(part)) throw new Error(`a part is one of ${[...MAPPING_PARTS, 'parent'].join(', ')}`);
          if (!from) throw new Error('name the Jira side');
          if (types.length > 0 && part !== 'fields') throw new Error('only a field pair names issue types');
          const named = (type: string): boolean => types.some((held) => held.toLowerCase() === type.toLowerCase());
          const rest =
            types.length === 0
              ? (next.mapping[part] ?? []).filter((pair) => pair.jira.toLowerCase() !== from.toLowerCase())
              : (next.mapping[part] ?? []).flatMap((pair) => {
                  if (pair.jira.toLowerCase() !== from.toLowerCase() || !pair.types?.length) return [pair];
                  const left = pair.types.filter((type) => !named(type));
                  return left.length > 0 ? [{ ...pair, types: left }] : [];
                });
          if (marks.push && part === 'fields') throw new Error('--push names the Jira value a Backlog value is sent as; a field takes --owner');
          if (marks.owner && part !== 'fields') throw new Error('--owner is for a field pair');
          // the one Jira value a Backlog value is sent as: marking one unmarks the others of that Backlog value
          const unmarked =
            marks.push && to !== null
              ? rest.map((pair) => (pair.eidos.toLowerCase() === to.toLowerCase() && pair.push ? { jira: pair.jira, eidos: pair.eidos, ...(pair.types ? { types: pair.types } : {}) } : pair))
              : rest;
          next.mapping[part] =
            to === null
              ? rest
              : [...unmarked, { jira: from, eidos: to, ...(types.length > 0 ? { types } : {}), ...(marks.push ? { push: true } : {}), ...(marks.owner ? { owner: marks.owner } : {}) }];
        }
        await writeConnections(
          host,
          connections(host).map((held) => (held.name === connection.name ? next : held)),
        );
        return { connection: next, problems: checkMapping(next, backlogOf(host).settings(), cachedDescription(host.workspace, connection.name)) };
      },
      problems: (name) => {
        const connection = connectionNamed(host, name);
        return checkMapping(connection, backlogOf(host).settings(), cachedDescription(host.workspace, connection.name));
      },
      model: async (name, refresh) => {
        const connection = connectionNamed(host, name);
        return editorModel(connection, backlogOf(host).settings(), await description(connection, refresh));
      },
      saveMapping: async (name, chosen) => {
        const connection = connectionNamed(host, name);
        const board = backlogOf(host).settings();
        const model = editorModel(connection, board, await description(connection, false));
        // the editor draws each part's choices alone; what it does not draw (a pair's push mark or owner, the users, the
        // transition fields, the create defaults) is kept as the mapping holds it
        const marked = (part: MappingPart, pair: Pair): Pair => {
          const held = (connection.mapping[part] ?? []).find((entry) => entry.jira.toLowerCase() === pair.jira.toLowerCase() && entry.eidos.toLowerCase() === pair.eidos.toLowerCase());
          return { ...pair, ...(held?.push ? { push: true } : {}), ...(held?.owner ? { owner: held.owner } : {}) };
        };
        const pairs = (part: MappingPart, values: Record<string, string> | undefined): Pair[] =>
          Object.entries(values ?? {}).flatMap(([jira, eidos]) => (eidos ? [marked(part, { jira, eidos })] : []));
        const mapping: Mapping = {
          types: pairs('types', chosen.types),
          statuses: pairs('statuses', chosen.statuses),
          priorities: pairs('priorities', chosen.priorities),
          link_types: pairs('link_types', chosen.link_types),
          fields: compactFields(Array.isArray(chosen.fields) ? chosen.fields : [], model, connection.mapping.fields ?? []).map((pair) => marked('fields', pair)),
          ...(connection.mapping.users ? { users: connection.mapping.users } : {}),
          ...(PARENT_RULES.includes(chosen.parent) ? { parent: chosen.parent } : {}),
          ...(connection.mapping.transition_fields ? { transition_fields: connection.mapping.transition_fields } : {}),
          ...(connection.mapping.create ? { create: connection.mapping.create } : {}),
        };
        const next = { ...connection, mapping };
        await writeConnections(
          host,
          connections(host).map((held) => (held.name === connection.name ? next : held)),
        );
        return { connection: next, problems: checkMapping(next, board, cachedDescription(host.workspace, connection.name)) };
      },
      addProperty: async (declaration) => {
        await backlogOf(host).addProperty(declaration);
      },
      syncPlan: async (ref, options = {}) => {
        const task = taskFor(backlogOf(host), ref);
        const context = await contextFor(host, connectionOfTask(host, task));
        return (await prepareSync(context, task, options)).plan;
      },
      sync: async (ref, options = {}) => {
        const task = taskFor(backlogOf(host), ref);
        const context = await contextFor(host, connectionOfTask(host, task));
        return applySync(context, await prepareSync(context, task, options));
      },
      comment: async (ref, text) => {
        const task = taskFor(backlogOf(host), ref);
        return sendComment(await contextFor(host, connectionOfTask(host, task)), task, text);
      },
      syncStatus: (name) => {
        const backlog = backlogOf(host);
        const chosen = name ? [connectionNamed(host, name)] : connections(host);
        return chosen.map((connection) => {
          const linked = backlog.tasks().filter((task) => {
            const held = heldOf(task);
            return held !== null && siteKey(held.site) === siteKey(connection.site);
          });
          const pending = backlog
            .tasks()
            .filter((task) => {
              const held = task.properties['jira'] as { pending?: unknown; connection?: unknown } | null | undefined;
              return typeof held?.pending === 'string' && held.connection === connection.name;
            })
            .map((task) => task.id ?? task.name);
          const interrupted = linked.flatMap((task) => {
            const journal = journalOf(host.workspace, heldOf(task)!.id);
            return journal ? [{ key: journal.key, at: journal.at }] : [];
          });
          return { connection: connection.name, edited: editedHere({ backlog, connection }), pending, interrupted };
        });
      },
      createPlan: async (refs, name, options = {}) => {
        const backlog = backlogOf(host);
        const tasks = parentsFirst(refs.map((ref) => taskFor(backlog, ref)));
        const context = await contextFor(host, connectionNamed(host, name));
        const batch = new Set(tasks.map((task) => (task.id ?? task.name).toLowerCase()));
        const out: CreatePlan[] = [];
        for (const task of tasks) out.push((await prepareCreate(context, task, { ...options, batch })).plan);
        return out;
      },
      create: async (refs, name, options = {}) => {
        const backlog = backlogOf(host);
        const tasks = parentsFirst(refs.map((ref) => taskFor(backlog, ref)));
        const context = await contextFor(host, connectionNamed(host, name));
        const batch = new Set(tasks.map((task) => (task.id ?? task.name).toLowerCase()));
        // Jira Push REQ4: nothing of the batch is made while one of its tasks is stopped
        const stopped: string[] = [];
        for (const task of tasks) {
          const plan = (await prepareCreate(context, task, { ...options, batch })).plan;
          if (plan.blockers.length > 0) stopped.push(`${plan.task}: ${plan.blockers.map((blocker) => blocker.message).join('; ')}`);
        }
        if (stopped.length > 0) throw new SyncRefused(`nothing was created; settle these first:\n  ${stopped.join('\n  ')}`);
        const out: Created[] = [];
        // each planned again as its turn comes, so a sub-task finds the issue its parent was just given
        for (const task of tasks) out.push(await createIssue(context, await prepareCreate(context, backlog.get(task.id ?? task.name), { ...options, batch }), options));
        return out;
      },
    };

    host.command((command) => {
      command.description('Jira Cloud: connect a board, sign in, describe it, map it to the Backlog, fetch and pull its issues, and sync a task back or create an issue from one');

      command
        .command('login')
        .argument('<site>', 'the Jira site, <name>.atlassian.net')
        .option('--global', 'make it the default sign-in for every root on this machine, not only the one this root uses')
        .option('--email <email>', 'the Atlassian account email (asked when not given)')
        .description('sign in to a Jira site with your Atlassian email and an API token, checked against Jira before it is kept')
        .action(
          action(async (site: string, options: { global?: boolean; email?: string }) => {
            let email = options.email?.trim() ?? '';
            let token = '';
            if (process.stdin.isTTY) {
              if (!email) email = await ask('Atlassian email: ', false);
              token = await ask('API token (https://id.atlassian.com/manage-profile/security/api-tokens): ', true);
            } else {
              const lines = await readLines(email ? 1 : 2);
              if (!email) email = lines.shift() ?? '';
              token = lines.shift() ?? '';
            }
            const me = await api.login(site, email, token, options.global === true);
            print(`Signed in to ${me.site} as ${me.name} (${me.email}), kept for ${options.global ? 'this machine' : 'this root'}, the token in ${tokensFile()}.`);
          }),
        );

      command
        .command('logout')
        .argument('<site>', 'the Jira site')
        .option('--email <email>', 'sign out only this account')
        .description("remove this root's and this machine's sign-in to a site, and its tokens from the credentials file; with --email, that account's alone")
        .action(
          action(async (site: string, options: { email?: string }) => {
            const out = await api.logout(site, options.email);
            print(out.length > 0 ? `Signed out of ${siteKey(site)}: ${out.join(', ')}.` : `Nobody was signed in to ${siteKey(site)} here.`);
          }),
        );

      command
        .command('use')
        .argument('<site>', 'the Jira site')
        .argument('<email>', 'an account signed in to it on this machine')
        .option('--global', 'make it the default for every root on this machine, not only the account this root uses')
        .description('choose which kept sign-in a site uses, for this root or as the default for every root')
        .action(
          action(async (site: string, email: string, options: { global?: boolean }) => {
            await api.use(site, email, options.global === true);
            print(`${siteKey(site)} signs in as ${email} ${options.global ? 'by default on this machine' : 'in this root'}.`);
          }),
        );

      command
        .command('whoami')
        .option('--json', 'print as JSON')
        .description("each site this root's connections use, with the account and where it is kept")
        .action(
          action((options: { json?: boolean }) => {
            const rows = api.signIns().map(({ site, email, kept }) => ({ site, email, kept }));
            if (options.json) return json(rows);
            if (rows.length === 0) return print('This root has no Jira connection; eidos jira connect adds one.');
            for (const row of rows) print(row.email ? `${row.site}: ${row.email}, kept for ${row.kept}` : `${row.site}: nobody signed in (eidos jira login ${row.site})`);
          }),
        );

      command
        .command('connect')
        .argument('<name>', "the connection's name")
        .requiredOption('--site <site>', 'the Jira site, <name>.atlassian.net')
        .requiredOption('--project <key>', "the project's key")
        .option('--board <id>', 'a board whose filter sets the scope')
        .option('--jql <jql>', 'JQL that narrows the scope further')
        .option('--direction <direction>', 'pull (Jira to Eidos); push is not built yet', 'pull')
        .option('--restricted-comments', 'pull comments Jira restricts to a role or a group too')
        .description('add a connection to this root, shared with everyone in it')
        .action(
          action(async (name: string, options: { site: string; project: string; board?: string; jql?: string; direction: string; restrictedComments?: boolean }) => {
            if (options.direction !== 'pull' && options.direction !== 'push') throw new Error('a direction is pull or push');
            const made = await api.connect({
              direction: options.direction,
              name,
              site: options.site,
              project: options.project,
              ...(options.board ? { board: options.board } : {}),
              ...(options.jql ? { jql: options.jql } : {}),
              restricted_comments: options.restrictedComments === true,
            });
            print(
              `Added ${made.name}: ${made.direction} ${made.project} on ${siteKey(made.site)}${made.board ? `, board ${made.board}` : ''}. Next: eidos jira describe ${made.name}, then eidos jira map ${made.name}.`,
            );
          }),
        );

      command
        .command('disconnect')
        .argument('<name>', "the connection's name")
        .description('take a connection out of this root; the tasks it pulled stay')
        .action(
          action(async (name: string) => {
            const found = connectionNamed(host, name);
            await api.disconnect(found.name);
            print(`Removed ${found.name}; the tasks it pulled stay where they are.`);
          }),
        );

      command
        .command('describe')
        .argument('<connection>', "the connection's name")
        .option('--refresh', 'read it from Jira again')
        .option('--json', 'print as JSON')
        .description("what Jira holds that a mapping is made against: the board's columns, the issue types with their statuses and fields, the priorities, the link types, and the sprints")
        .action(
          action(async (name: string, options: { refresh?: boolean; json?: boolean }) => {
            const read = await description(connectionNamed(host, name), options.refresh === true);
            if (options.json) json(read);
            else print(describeDescription(read));
          }),
        );

      command
        .command('map')
        .argument('<connection>', "the connection's name")
        .option('--yes', 'accept every proposed entry without asking')
        .option('--json', 'print the draft as JSON and write nothing')
        .description('draft the mapping from what describe read and the Backlog, by names and categories; each entry accepted or rejected before anything is written')
        .action(
          action(async (name: string, options: { yes?: boolean; json?: boolean }) => {
            const connection = connectionNamed(host, name);
            const read = await description(connection, false);
            const draft = draftMapping(connection, backlogOf(host).settings(), read);
            if (options.json) return json(draft);
            if (draft.entries.length === 0) print(`${connection.name}: nothing new to propose.`);
            const accepted: typeof draft.entries = [];
            for (const proposed of draft.entries) {
              const line = `${proposed.part}: ${proposed.jira} → ${proposed.eidos} (${proposed.why})`;
              if (options.yes) {
                accepted.push(proposed);
                print(`+ ${line}`);
              } else if (process.stdin.isTTY) {
                if (await confirm(`Map ${line}?`)) accepted.push(proposed);
              } else print(`  ${line}`);
            }
            for (const left of draft.unmatched) print(`? ${left}; add it to the Backlog (eidos backlog configure:…) or map it by hand with eidos jira configure:map`);
            if (!options.yes && !process.stdin.isTTY) {
              if (draft.entries.length > 0) print('Nothing written: run in a terminal to accept entry by entry, or pass --yes to accept them all.');
              return;
            }
            if (accepted.length === 0) return;
            await api.accept(connection.name, accepted);
            print(`${connection.name}: ${accepted.length} entries written to the mapping.`);
          }),
        );

      command
        .command('configure:map')
        .argument('<connection>', "the connection's name")
        .argument('<operation>', 'set or unset')
        .argument('<part>', `one of ${[...MAPPING_PARTS, 'parent', 'transition_fields', 'create.types', 'create.fields'].join(', ')}`)
        .argument('[from]', 'the Jira side (a type, status, priority, link type, or field id); for parent, subtasks, all, or none')
        .argument('[to]', 'the Eidos side, for set')
        .option('--types <names>', "a field pair's issue types, comma-separated; the pair then holds for those types alone")
        .option('--push', 'the Jira value a sync or a create sends for the Backlog value, where several Jira values read as it')
        .option('--owner <side>', "a field's owner: jira (never sent) or eidos (never pulled over; a Jira change is a conflict)")
        .description('change one entry of a mapping')
        .action(
          action(async (name: string, operation: string, part: string, from: string | undefined, to: string | undefined, options: { types?: string; push?: boolean; owner?: string }) => {
            if (options.owner !== undefined && options.owner !== 'jira' && options.owner !== 'eidos') throw new Error('--owner is jira or eidos');
            const connection = connectionNamed(host, name);
            if (operation !== 'set' && operation !== 'unset') throw new Error('the operation is set or unset');
            if (part !== 'parent' && operation === 'set' && !to) throw new Error('name the Eidos side to set it to');
            const unset = operation === 'unset';
            const types = (options.types ?? '')
              .split(',')
              .map((type) => type.trim())
              .filter(Boolean);
            // a part the mapping did not hold yet carries only what it names once it holds one entry (Jira REQ7), so the
            // person is told what the first entry of it starts leaving out
            const starts = operation === 'set' && (['types', 'priorities', 'link_types', 'fields'] as string[]).includes(part) && connection.mapping[part as MappingPart] === undefined;
            const known = [...MAPPING_PARTS, 'parent', 'transition_fields', 'create.types', 'create.fields'];
            if (!known.includes(part)) throw new Error(`a part is one of ${known.join(', ')}`);
            const { problems } = await api.setPair(connection.name, part as Parameters<JiraApi['setPair']>[1], from ?? '', unset ? null : part === 'parent' ? (from ?? '') : (to ?? ''), types, {
              ...(options.push ? { push: true } : {}),
              ...(options.owner ? { owner: options.owner as 'jira' | 'eidos' } : {}),
            });
            const scope = types.length > 0 ? ` (${types.join(', ')})` : '';
            print(`${connection.name}: ${part} ${operation === 'set' ? `${from} → ${part === 'parent' ? '' : to}${scope}` : `${from ?? ''}${scope} unset`}`.trim());
            for (const problem of problems) print(`  jira/${problem.code}: ${problem.message}`);
            if (starts)
              print(
                `  note: ${connection.name} had no ${part} part, so every ${part === 'fields' ? 'default field' : part.replace(/_/g, ' ').replace(/s$/, '')} went by its name; from now on only the ${part} named here are carried (eidos jira map ${connection.name} drafts the rest)`,
              );
          }),
        );

      command
        .command('fetch')
        .argument('[connection]', 'one connection; every pull connection when none is named')
        .option('--full', 'read the whole scope, not only what changed since the last pull')
        .option('--json', 'print as JSON')
        .description('show what a pull would do, writing nothing to the root')
        .action(
          action(async (name: string | undefined, options: { full?: boolean; json?: boolean }) => {
            const plans: Plan[] = [];
            for (const connection of pullConnections(host, name)) plans.push((await run(await contextFor(host, connection), false, { full: options.full === true })).plan);
            if (options.json) json(plans);
            else for (const plan of plans) print(describePlan(plan));
          }),
        );

      command
        .command('pull')
        .argument('[connection]', 'one connection; every pull connection when none is named')
        .option('--dry-run', 'show what it would do and write nothing (a fetch)')
        .option('--full', 'read the whole scope, not only what changed since the last pull')
        .option('--keep-local', 'leave the mapped fields edited in the root as the root has them')
        .option('--json', 'print as JSON')
        .description("bring a connection's issues into the Backlog: tasks, and their comments as threads signed by the people who wrote them")
        .action(
          action(async (name: string | undefined, options: { dryRun?: boolean; full?: boolean; keepLocal?: boolean; json?: boolean }) => {
            const out: Array<Plan | Done> = [];
            for (const connection of pullConnections(host, name)) {
              const result = await run(await contextFor(host, connection), options.dryRun !== true, { full: options.full === true, keepLocal: options.keepLocal === true });
              out.push(result.done ?? result.plan);
            }
            if (options.json) return json(out);
            for (const result of out) print('since' in result ? describePlan(result) : describeDone(result));
          }),
        );

      command
        .command('status')
        .argument('[connection]', 'one connection; every one when none is named')
        .option('--json', 'print as JSON')
        .description('the tasks edited here since their last pull or sync, and any create or sync cut short, read from the root without asking Jira')
        .action(
          action((name: string | undefined, options: { json?: boolean }) => {
            const rows = api.syncStatus(name);
            if (options.json) return json(rows);
            for (const row of rows) {
              print(`${row.connection}: ${row.edited.length === 0 ? 'nothing edited here since the last pull or sync' : `${row.edited.length} task${row.edited.length === 1 ? '' : 's'} edited here`}`);
              for (const edited of row.edited) print(`  ~ ${edited.key}  ${edited.task}: ${edited.sides.join(', ')}`);
              for (const task of row.pending) print(`  … ${task}: a create was cut short; eidos jira create ${task} --connection ${row.connection} finds its issue`);
              for (const cut of row.interrupted) print(`  … ${cut.key}: a sync was cut short at ${cut.at}; eidos jira sync ${cut.key} finishes it`);
            }
          }),
        );

      const collect = (value: string, held: string[] = []): string[] => [...held, value];
      command
        .command('sync')
        .argument('[tasks...]', 'tasks by their id or their issue key')
        .option('--connection <name>', 'every task of a connection edited here since its last pull or sync, one issue at a time')
        .option('--dry-run', 'show what it would do and write nothing')
        .option('--take <side=jira|eidos>', "settle a field changed on both sides: its side (title, status, section:description, or all) to Jira's value or the task's", collect)
        .option('--accept-loss <side>', 'write a text field though Jira loses what markdown cannot hold (a panel, a file); `all` for every field', collect)
        .option('--status-to <status>', "the Jira status to go to when several read as the task's status")
        .option('--via <statuses>', 'Jira statuses to pass through, comma-separated, when the status asked for is more than one transition away')
        .option('--field <field=value>', "a value a transition's screen asks for (resolution=Done)", collect)
        .option('--no-comments', "leave your messages in the issue's thread unsent")
        .option('--yes', 'sync without asking, once nothing is left to settle')
        .option('--json', 'print as JSON')
        .description('bring a task and its Jira issue level, field by field: what changed in Jira comes in, what changed here goes out, and what changed in both is yours to settle first')
        .action(
          action(
            async (
              refs: string[],
              options: {
                connection?: string;
                dryRun?: boolean;
                take?: string[];
                acceptLoss?: string[];
                statusTo?: string;
                via?: string;
                field?: string[];
                comments?: boolean;
                yes?: boolean;
                json?: boolean;
              },
            ) => {
              const take = pairsOf(options.take, '--take');
              for (const [side, chosen] of Object.entries(take)) if (chosen !== 'jira' && chosen !== 'eidos') throw new Error(`--take ${side} is jira or eidos`);
              const base: SyncOptions = {
                take: take as Record<string, 'jira' | 'eidos'>,
                acceptLoss: options.acceptLoss ?? [],
                ...(options.statusTo ? { statusTo: options.statusTo } : {}),
                ...(options.via
                  ? {
                      via: options.via
                        .split(',')
                        .map((status) => status.trim())
                        .filter(Boolean),
                    }
                  : {}),
                transitionFields: pairsOf(options.field, '--field'),
                noComments: options.comments === false,
              };
              const targets = [...refs];
              if (options.connection) for (const edited of editedHere({ backlog: backlogOf(host), connection: connectionNamed(host, options.connection) })) targets.push(edited.task);
              if (targets.length === 0) throw new Error('name the tasks to sync, or --connection for every task edited here');
              const results: Array<{ plan: SyncPlan; done: SyncDone | null; skipped?: string }> = [];
              const interactive = process.stdin.isTTY && !options.json && !options.yes;
              for (const ref of [...new Set(targets)]) {
                let chosen: SyncOptions = { ...base, take: { ...base.take } };
                let plan = await api.syncPlan(ref, chosen);
                // a conflict, or text Jira would lose, put to the person one at a time
                while (interactive && !options.dryRun && plan.blockers.some((blocker) => blocker.code === 'conflict' || blocker.code === 'unrecorded' || blocker.code === 'loss')) {
                  if (!options.json) print(describeSync(plan));
                  const blocker = plan.blockers.find((held) => held.code === 'conflict' || held.code === 'unrecorded' || held.code === 'loss')!;
                  const side = blocker.side ?? 'all';
                  if (blocker.code === 'loss') {
                    if (!(await confirm(`Write ${side} anyway, losing what Jira holds that markdown cannot?`))) break;
                    chosen = { ...chosen, acceptLoss: [...(chosen.acceptLoss ?? []), side] };
                  } else {
                    const answer = (await ask(`${side}: keep [j]ira's, keep [e]idos's, or [s]kip ${plan.key}? `, false)).toLowerCase();
                    if (answer.startsWith('j')) chosen = { ...chosen, take: { ...chosen.take, [side]: 'jira' } };
                    else if (answer.startsWith('e')) chosen = { ...chosen, take: { ...chosen.take, [side]: 'eidos' } };
                    else break;
                  }
                  plan = await api.syncPlan(ref, chosen);
                }
                if (!options.json) print(describeSync(plan));
                if (plan.blockers.length > 0) {
                  results.push({ plan, done: null, skipped: 'blocked' });
                  process.exitCode = 1;
                  continue;
                }
                const moving = plan.fields.some((field) => field.verdict !== 'unchanged') || plan.comments.length > 0;
                if (options.dryRun || !moving) {
                  results.push({ plan, done: null });
                  continue;
                }
                if (!options.yes) {
                  if (!interactive) {
                    if (!options.json) print('  nothing written: run in a terminal to confirm, or pass --yes');
                    results.push({ plan, done: null, skipped: 'unconfirmed' });
                    continue;
                  }
                  if (!(await confirm(`Sync ${plan.key}?`))) {
                    results.push({ plan, done: null, skipped: 'declined' });
                    continue;
                  }
                }
                // the sync carries what this plan read of Jira, so a field Jira changed while the person read it is not sent
                const done = await api.sync(ref, { ...chosen, expect: Object.fromEntries(plan.fields.map((field) => [field.side, field.seen])) });
                results.push({ plan, done });
                if (!options.json) {
                  const parts = [
                    ...(done.to_jira.length > 0 ? [`sent ${done.to_jira.join(', ')}`] : []),
                    ...(done.from_jira.length > 0 ? [`took ${done.from_jira.join(', ')}`] : []),
                    ...(done.comments > 0 ? [`${done.comments} comment${done.comments === 1 ? '' : 's'} sent`] : []),
                  ];
                  print(`  synced ${done.key}${parts.length > 0 ? `: ${parts.join('; ')}` : ''}`);
                  for (const kept of done.kept_by_jira) print(`  ⚠ Jira kept ${kept.side} as ${kept.value}; the next sync shows it`);
                }
              }
              if (options.json) json(results);
            },
          ),
        );

      command
        .command('comment')
        .argument('<task>', 'a task by its id or its issue key')
        .argument('<text...>', 'the comment, in markdown')
        .description("send a comment to a task's Jira issue now, as the account you sign in with, and keep it in the issue's thread here")
        .action(
          action(async (ref: string, words: string[]) => {
            const sent = await api.comment(ref, words.join(' '));
            print(`Comment sent to ${sent.key}.`);
          }),
        );

      command
        .command('create')
        .argument('<tasks...>', 'tasks by their id')
        .requiredOption('--connection <name>', 'the connection whose project the issues are made in')
        .option('--type <type>', "the Jira issue type, where several read as the task's type")
        .option('--field <field=value>', 'a value for a field Jira requires and the task does not hold', collect)
        .option('--again', 'create anew a task whose earlier create was cut short and whose issue cannot be found')
        .option('--yes', 'create without asking, once nothing is left to settle')
        .option('--json', 'print as JSON')
        .description('make a Jira issue from each task and link the task to it; from then on, eidos jira sync carries its changes')
        .action(
          action(async (refs: string[], options: { connection: string; type?: string; field?: string[]; again?: boolean; yes?: boolean; json?: boolean }) => {
            const chosen: CreateOptions = { ...(options.type ? { type: options.type } : {}), fields: pairsOf(options.field, '--field'), again: options.again === true };
            const plans = await api.createPlan(refs, options.connection, chosen);
            if (!options.json) for (const plan of plans) print(describeCreate(plan));
            if (plans.some((plan) => plan.blockers.length > 0)) {
              if (options.json) json({ plans, created: [] });
              else print('Nothing created: settle what is marked ✗ first.');
              process.exitCode = 1;
              return;
            }
            if (!options.yes) {
              if (!process.stdin.isTTY || options.json) {
                if (options.json) json({ plans, created: [] });
                else print('Nothing created: run in a terminal to confirm, or pass --yes.');
                return;
              }
              if (!(await confirm(`Create ${plans.length} Jira issue${plans.length === 1 ? '' : 's'} in ${plans[0]?.project}?`))) return;
            }
            const created = await api.create(refs, options.connection, chosen);
            if (options.json) return json({ plans, created });
            for (const made of created) {
              print(`${made.task} → ${made.key}  ${made.url}${made.found ? ' (found by its mark)' : ''}`);
              if (made.differs.length > 0) print(`    Jira holds ${made.differs.join(', ')} otherwise; eidos jira sync ${made.task} sends the task's`);
            }
          }),
        );
    });

    // ---- findings ------------------------------------------------------------------------
    const mappingProblems = (code: MappingProblem['code']) => (): FoundProblem[] => {
      const backlog = host.plugin<BacklogApi>('backlog');
      if (!backlog) return [];
      const board = backlog.settings();
      return connections(host).flatMap((connection) =>
        checkMapping(connection, board, cachedDescription(host.workspace, connection.name))
          .filter((problem) => problem.code === code)
          .map((problem) => ({ path: SETTINGS_PATH, message: problem.message })),
      );
    };
    host.finding({ code: 'pair-type', level: 'warning', run: mappingProblems('pair-type') });
    host.finding({ code: 'option-missing', level: 'warning', run: mappingProblems('option-missing') });
    host.finding({ code: 'direction', level: 'error', run: mappingProblems('direction') });
    host.finding({ code: 'target-unknown', level: 'warning', run: mappingProblems('target-unknown') });
    host.finding({
      code: 'duplicate',
      level: 'warning',
      run: () => {
        const backlog = host.plugin<BacklogApi>('backlog');
        if (!backlog) return [];
        const seen = new Map<string, string[]>();
        for (const task of backlog.tasks()) {
          const held = task.properties['jira'] as { site?: string; id?: string; key?: string } | undefined;
          if (!held?.site || !held.id) continue;
          const key = `${siteKey(held.site)}#${held.id}`;
          seen.set(key, [...(seen.get(key) ?? []), task.id ?? task.name]);
        }
        return [...seen.entries()]
          .filter(([, tasks]) => tasks.length > 1)
          .map(([key, tasks]) => ({
            path: null,
            message: `${tasks.join(' and ')} hold one Jira issue (${key.split('#')[1]}); keep one and merge the other into it (eidos backlog show, then eidos backlog remove the other)`,
          }));
      },
    });

    // ---- auto_fetch (Jira Pull REQ13): a fetch soon after the root opens and each interval after, where the app's server runs ----
    if (host.serving) {
      const minutes = Number(host.settings().get<string>('auto_fetch'));
      if (Number.isFinite(minutes) && minutes > 0) {
        const tick = async (): Promise<void> => {
          for (const connection of connections(host).filter((entry) => entry.direction === 'pull')) {
            try {
              const plan = await fetchOne(connection);
              host.emit('fetched', { connection: connection.name, count: plan.add.length + plan.change.length + plan.gone.length });
            } catch (error) {
              const state = readState(host.workspace, connection.name);
              writeState(host.workspace, connection.name, {
                ...state,
                last_fetch: { at: new Date().toISOString(), count: state.last_fetch?.count ?? 0, error: error instanceof Error ? error.message : String(error) },
              });
              host.emit('fetched', { connection: connection.name, error: error instanceof Error ? error.message : String(error) });
            }
          }
        };
        timers.push(setTimeout(() => void tick(), 10_000));
        timers.push(setInterval(() => void tick(), minutes * 60_000));
      }
    }

    return {
      api,
      dispose: () => {
        for (const timer of timers) clearTimeout(timer);
      },
    };
  },
};

export default entry;
