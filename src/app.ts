// The Jira plugin's app entry, which only the Eidos MD app mounts: the routes
// its settings page and the Backlog's Fetch and Pull row call, under
// `/api/plugins/jira/`. Each answers through the CLI entry's API, so a sign-in,
// a connection, a mapping, or a pull made from the page is the one a command
// makes. A token reaches the login route and goes straight to the credentials
// file; no answer carries it back.
import { HostError, type AppEntry, type AppHost } from 'eidosmd/plugin';
import { fromBoardUrl } from './connections.ts';
import type { JiraApi } from './index.ts';
import type { MappingChoice } from './mapping.ts';
import type { MappingPart } from './connections.ts';
import type { SyncOptions } from './sync.ts';
import type { CreateOptions } from './create.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

// what a refusal from the plugin's own rules says to the page, as a 400 with its words
async function answer<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof HostError) throw cause;
    throw new HostError(400, cause instanceof Error ? cause.message : String(cause));
  }
}

// The options a create is run with, as the page's review sends them: the issue type, the values Jira requires, and whether
// a cut-short create whose issue cannot be found is made again.
function createOptions(value: unknown): CreateOptions {
  const held = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const fields = typeof held['fields'] === 'object' && held['fields'] !== null && !Array.isArray(held['fields']) ? (held['fields'] as Record<string, unknown>) : {};
  return {
    ...(text(held['type']) ? { type: text(held['type']) } : {}),
    fields: Object.fromEntries(Object.entries(fields).flatMap(([key, item]) => (text(item) ? [[key, text(item)]] : []))),
    again: held['again'] === true,
  };
}

const SETTINGS = ['pull_attachments', 'attachments_folder', 'add_people', 'auto_fetch', 'auto_sync_on_save', 'auto_sync_on_push'] as const;

// The options a sync is run with, as the page's review sends them: only what it can choose, each checked here.
function syncOptions(value: unknown): SyncOptions {
  const held = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const strings = (record: unknown): Record<string, string> =>
    typeof record === 'object' && record !== null && !Array.isArray(record) ? Object.fromEntries(Object.entries(record).flatMap(([key, item]) => (text(item) ? [[key, text(item)]] : []))) : {};
  const take = Object.fromEntries(Object.entries(strings(held['take'])).filter(([, side]) => side === 'jira' || side === 'eidos' || side === 'both')) as Record<string, 'jira' | 'eidos' | 'both'>;
  // a section's merged text as the review built it, kept whole: a blank line in it is the person's
  const resolved =
    typeof held['resolved'] === 'object' && held['resolved'] !== null && !Array.isArray(held['resolved'])
      ? Object.fromEntries(Object.entries(held['resolved'] as Record<string, unknown>).filter((entry): entry is [string, string] => entry[0].startsWith('section:') && typeof entry[1] === 'string'))
      : {};
  return {
    take,
    resolved,
    acceptLoss: Array.isArray(held['accept_loss']) ? held['accept_loss'].map(text).filter(Boolean) : [],
    ...(text(held['status_to']) ? { statusTo: text(held['status_to']) } : {}),
    ...(Array.isArray(held['via']) ? { via: held['via'].map(text).filter(Boolean) } : {}),
    transitionFields: strings(held['fields']),
    noComments: held['no_comments'] === true,
    ...(typeof held['expect'] === 'object' && held['expect'] !== null ? { expect: strings(held['expect']) } : {}),
  };
}

function state(host: AppHost, api: JiraApi): Record<string, unknown> {
  const status = api.status();
  const waiting = api.syncStatus();
  const paused = api.pauses();
  return {
    sign_ins: api.signIns(),
    held: api.heldSignIns(),
    connections: api.connections().map((connection) => ({
      ...connection,
      problems: api.problems(connection.name),
      status: status.find((entry) => entry.connection === connection.name) ?? null,
      sync: waiting.find((entry) => entry.connection === connection.name) ?? null,
      paused: paused.find((entry) => entry.connection === connection.name) ?? null,
    })),
    settings: Object.fromEntries(SETTINGS.map((name) => [name, host.settings().get(name)])),
    needs: api.needs(),
    // the folders the Assets plugin manages, where downloaded attachments may go; null with the Assets plugin off
    asset_folders: api.assetFolders(),
  };
}

const entry: AppEntry<JiraApi> = {
  name: 'jira',
  mount(host, api) {
    host.route('GET', 'state', () => state(host, api));

    host.route('POST', 'login', (request) =>
      answer(async () => {
        const signed = await api.login(text(request.body['site']), text(request.body['email']), text(request.body['token']), request.body['global'] === true);
        return { signed, state: state(host, api) };
      }),
    );
    host.route('POST', 'logout', (request) =>
      answer(async () => {
        const out = await api.logout(text(request.body['site']), text(request.body['email']) || undefined);
        return { signed_out: out, state: state(host, api) };
      }),
    );
    host.route('POST', 'use', (request) =>
      answer(async () => {
        await api.use(text(request.body['site']), text(request.body['email']), request.body['global'] === true);
        return { state: state(host, api) };
      }),
    );

    host.route('POST', 'connect', (request) =>
      answer(async () => {
        const fromUrl = text(request.body['url']) ? fromBoardUrl(text(request.body['url'])) : null;
        if (text(request.body['url']) && !fromUrl) throw new Error("that is not a Jira board's address (…/projects/<KEY>/boards/<n>)");
        const project = fromUrl?.project ?? text(request.body['project']);
        const board = fromUrl?.board ?? request.body['board'];
        // the name commands take: the project's key in lower case, with the board's id once another connection holds it
        const base = text(request.body['name']) || project.toLowerCase();
        const taken = new Set(api.connections().map((held) => held.name.toLowerCase()));
        const name = taken.has(base.toLowerCase()) && board ? `${base}-${String(board)}` : base;
        const made = await api.connect({
          name,
          ...(text(request.body['title']) ? { title: text(request.body['title']) } : {}),
          site: fromUrl?.site ?? text(request.body['site']),
          project,
          ...(board ? { board: String(board) } : {}),
          ...(text(request.body['jql']) ? { jql: text(request.body['jql']) } : {}),
        });
        return { connection: made, state: state(host, api) };
      }),
    );
    host.route('GET', 'boards', (request) => answer(() => api.boards(request.query.get('site') ?? undefined)));
    host.route('POST', 'resume', (request) =>
      answer(() => {
        api.resume(text(request.body['name']));
        return { state: state(host, api) };
      }),
    );
    host.route('POST', 'disconnect', (request) =>
      answer(async () => {
        await api.disconnect(text(request.body['name']));
        return { state: state(host, api) };
      }),
    );

    host.route('GET', 'describe', (request) => answer(() => api.describe(request.query.get('name') ?? '', request.query.get('refresh') === 'true')));
    host.route('GET', 'draft', (request) => answer(() => api.draft(request.query.get('name') ?? '')));
    host.route('POST', 'accept', (request) =>
      answer(async () => {
        const entries = Array.isArray(request.body['entries']) ? (request.body['entries'] as Array<{ part: MappingPart; jira: string; eidos: string }>) : [];
        await api.accept(text(request.body['name']), entries);
        return { state: state(host, api) };
      }),
    );
    host.route('POST', 'pair', (request) =>
      answer(async () => {
        const eidos = request.body['eidos'] === null ? null : text(request.body['eidos']);
        const done = await api.setPair(text(request.body['name']), text(request.body['part']) as MappingPart | 'parent', text(request.body['jira']), eidos);
        return { problems: done.problems, state: state(host, api) };
      }),
    );

    host.route('GET', 'model', (request) => answer(() => api.model(request.query.get('name') ?? '', request.query.get('refresh') === 'true')));
    host.route('PUT', 'mapping', (request) =>
      answer(async () => {
        const mapping = request.body['mapping'];
        if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) throw new Error('no mapping was sent');
        const done = await api.saveMapping(text(request.body['name']), mapping as MappingChoice);
        return { problems: done.problems, state: state(host, api) };
      }),
    );
    host.route('POST', 'property', (request) =>
      answer(async () => {
        const options = Array.isArray(request.body['options']) ? request.body['options'].map(text).filter(Boolean) : [];
        await api.addProperty({ name: text(request.body['name']), type: text(request.body['type']), ...(options.length > 0 ? { options } : {}) });
        return api.model(text(request.body['connection']), false);
      }),
    );

    host.route('PUT', 'settings', (request) =>
      answer(async () => {
        for (const [name, value] of Object.entries(request.body)) {
          if (!(SETTINGS as readonly string[]).includes(name)) throw new Error(`no setting '${name}' here`);
          await host.settings().set(name, value);
        }
        return { state: state(host, api) };
      }),
    );

    // Jira Sync from the page: the plan as the review draws it, then the sync once the person settled what it asked
    host.route('POST', 'sync-plan', (request) => answer(() => api.syncPlan(text(request.body['task']), syncOptions(request.body['options']))));
    host.route('POST', 'sync', (request) =>
      answer(async () => {
        const done = await api.sync(text(request.body['task']), syncOptions(request.body['options']));
        return { done, state: state(host, api) };
      }),
    );

    // Jira Push from the page: the task the open file holds, then the plan of its create and the create itself
    host.route('GET', 'task', (request) => answer(() => ({ task: api.taskAt(request.query.get('file') ?? '') })));
    host.route('POST', 'skip', (request) =>
      answer(async () => {
        api.skip(text(request.body['task']), request.body['on'] === true);
        return { state: state(host, api) };
      }),
    );
    host.route('POST', 'create-plan', (request) =>
      answer(async () => (await api.createPlan([text(request.body['task'])], text(request.body['connection']), createOptions(request.body['options'])))[0]),
    );
    host.route('POST', 'create', (request) =>
      answer(async () => {
        const created = (await api.create([text(request.body['task'])], text(request.body['connection']), createOptions(request.body['options'])))[0];
        return { created, state: state(host, api) };
      }),
    );

    host.route('POST', 'fetch', (request) => answer(() => api.fetch(text(request.body['name']) || undefined)));
    host.route('POST', 'pull', (request) => answer(() => api.pull(text(request.body['name']) || undefined, { full: request.body['full'] === true, keepLocal: request.body['keep_local'] === true })));
  },
};

export default entry;
