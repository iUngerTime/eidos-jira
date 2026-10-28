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
  MAPPING_PARTS,
  readConnection,
  removeSignIn,
  saveSignIn,
  SCOPE_WORDS,
  signIn,
  signedInSites,
  type Scope,
  siteKey,
  writeConnections,
  type Connection,
  type Mapping,
  type MappingPart,
  type Pair,
} from './connections.ts';
import { cachedDescription, keepDescription, readDescription, type Description } from './describe.ts';
import { checkMapping, compactFields, draftMapping, editorModel, type DraftEntry, type EditorModel, type MappingChoice, type MappingProblem, PARENT_RULES } from './mapping.ts';
import { ask, confirm, readLines } from './prompt.ts';
import { readState, run, writeState, type Done, type Plan } from './pull.ts';
import { tokensFile } from './tokens.ts';
import type { AssetsApi, BacklogApi, CommentsApi } from './types.ts';

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
  logout(site: string): Promise<string[]>;
  connect(input: { name: string; site: string; project: string; board?: string | number; jql?: string; direction?: 'pull' | 'push'; restricted_comments?: boolean }): Promise<Connection>;
  disconnect(name: string): Promise<void>;
  describe(name: string, refresh: boolean): Promise<Description>;
  draft(name: string): Promise<{ entries: DraftEntry[]; unmatched: string[] }>;
  accept(name: string, entries: Array<Pick<DraftEntry, 'part' | 'jira' | 'eidos'>>): Promise<Connection>;
  // a field pair naming issue types takes those types from the field's other pairs, and leaves its untyped pair be
  setPair(name: string, part: MappingPart | 'parent', jira: string, eidos: string | null, types?: string[]): Promise<{ connection: Connection; problems: MappingProblem[] }>;
  problems(name: string): MappingProblem[];
  // The mapping editor's half (Jira REQ12): what it draws, the whole mapping it saves, and a property made for a field
  model(name: string, refresh: boolean): Promise<EditorModel>;
  saveMapping(name: string, chosen: MappingChoice): Promise<{ connection: Connection; problems: MappingProblem[] }>;
  addProperty(declaration: { name: string; type: string; options?: string[] }): Promise<void>;
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
  const me = await client.get<{ timeZone?: string }>('/rest/api/3/myself');
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
  };
}

function pullConnections(host: Host, name: string | undefined): Connection[] {
  if (name) {
    const found = connectionNamed(host, name);
    if (found.direction !== 'pull') throw new Error(`${found.name} is a push connection; Jira Push is not built yet`);
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
      logout: (site) => removeSignIn(host, site),
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
      setPair: async (name, part, from, to, types = []) => {
        const connection = connectionNamed(host, name);
        const next = { ...connection, mapping: { ...connection.mapping } };
        if (part === 'parent') {
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
          next.mapping[part] = to === null ? rest : [...rest, { jira: from, eidos: to, ...(types.length > 0 ? { types } : {}) }];
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
        const pairs = (values: Record<string, string> | undefined): Pair[] => Object.entries(values ?? {}).flatMap(([jira, eidos]) => (eidos ? [{ jira, eidos }] : []));
        const mapping: Mapping = {
          types: pairs(chosen.types),
          statuses: pairs(chosen.statuses),
          priorities: pairs(chosen.priorities),
          link_types: pairs(chosen.link_types),
          fields: compactFields(Array.isArray(chosen.fields) ? chosen.fields : [], model, connection.mapping.fields ?? []),
          ...(PARENT_RULES.includes(chosen.parent) ? { parent: chosen.parent } : {}),
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
    };

    host.command((command) => {
      command.description('Jira Cloud: connect a board, sign in, describe it, map it to the Backlog, and fetch and pull its issues');

      command
        .command('login')
        .argument('<site>', 'the Jira site, <name>.atlassian.net')
        .option('--global', 'keep the sign-in for every root on this machine, not only this one')
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
        .description("remove this root's and this machine's sign-in to a site, and its tokens from the credentials file")
        .action(
          action(async (site: string) => {
            const out = await api.logout(site);
            print(out.length > 0 ? `Signed out of ${siteKey(site)}: ${out.join(', ')}.` : `Nobody was signed in to ${siteKey(site)} here.`);
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
        .argument('<part>', `one of ${[...MAPPING_PARTS, 'parent'].join(', ')}`)
        .argument('[from]', 'the Jira side (a type, status, priority, link type, or field id); for parent, subtasks, all, or none')
        .argument('[to]', 'the Eidos side, for set')
        .option('--types <names>', "a field pair's issue types, comma-separated; the pair then holds for those types alone")
        .description('change one entry of a mapping')
        .action(
          action(async (name: string, operation: string, part: string, from: string | undefined, to: string | undefined, options: { types?: string }) => {
            const connection = connectionNamed(host, name);
            if (operation !== 'set' && operation !== 'unset') throw new Error('the operation is set or unset');
            if (part !== 'parent' && operation === 'set' && !to) throw new Error('name the Eidos side to set it to');
            const unset = operation === 'unset';
            const types = (options.types ?? '')
              .split(',')
              .map((type) => type.trim())
              .filter(Boolean);
            const { problems } = await api.setPair(connection.name, part as MappingPart | 'parent', from ?? '', unset ? null : part === 'parent' ? (from ?? '') : (to ?? ''), types);
            const scope = types.length > 0 ? ` (${types.join(', ')})` : '';
            print(`${connection.name}: ${part} ${operation === 'set' ? `${from} → ${part === 'parent' ? '' : to}${scope}` : `${from ?? ''}${scope} unset`}`.trim());
            for (const problem of problems) print(`  jira/${problem.code}: ${problem.message}`);
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
