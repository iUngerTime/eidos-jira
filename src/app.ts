// The Jira plugin's app entry, which only the Eidos MD app mounts: the routes
// its settings page and the Backlog's Fetch and Pull row call, under
// `/api/plugins/jira/`. Each answers through the CLI entry's API, so a sign-in,
// a connection, a mapping, or a pull made from the page is the one a command
// makes. A token reaches the login route and goes straight to the credentials
// file; no answer carries it back.
import { HostError, type AppEntry, type AppHost } from 'eidosmd/plugin';
import { fromBoardUrl } from './connections.ts';
import type { JiraApi } from './index.ts';
import type { MappingPart } from './connections.ts';

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

const SETTINGS = ['pull_attachments', 'add_people', 'auto_fetch'] as const;

function state(host: AppHost, api: JiraApi): Record<string, unknown> {
  const status = api.status();
  return {
    sign_ins: api.signIns(),
    connections: api.connections().map((connection) => ({
      ...connection,
      problems: api.problems(connection.name),
      status: status.find((entry) => entry.connection === connection.name) ?? null,
    })),
    settings: Object.fromEntries(SETTINGS.map((name) => [name, host.settings().get(name)])),
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
        const out = await api.logout(text(request.body['site']));
        return { signed_out: out, state: state(host, api) };
      }),
    );

    host.route('POST', 'connect', (request) =>
      answer(async () => {
        const fromUrl = text(request.body['url']) ? fromBoardUrl(text(request.body['url'])) : null;
        if (text(request.body['url']) && !fromUrl) throw new Error("that is not a Jira board's address (…/projects/<KEY>/boards/<n>)");
        const project = fromUrl?.project ?? text(request.body['project']);
        const made = await api.connect({
          name: text(request.body['name']) || project.toLowerCase(),
          site: fromUrl?.site ?? text(request.body['site']),
          project,
          ...((fromUrl?.board ?? request.body['board']) ? { board: String(fromUrl?.board ?? request.body['board']) } : {}),
          ...(text(request.body['jql']) ? { jql: text(request.body['jql']) } : {}),
        });
        return { connection: made, state: state(host, api) };
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

    host.route('PUT', 'settings', (request) =>
      answer(async () => {
        for (const [name, value] of Object.entries(request.body)) {
          if (!(SETTINGS as readonly string[]).includes(name)) throw new Error(`no setting '${name}' here`);
          await host.settings().set(name, value);
        }
        return { state: state(host, api) };
      }),
    );

    host.route('POST', 'fetch', (request) => answer(() => api.fetch(text(request.body['name']) || undefined)));
    host.route('POST', 'pull', (request) => answer(() => api.pull(text(request.body['name']) || undefined, { full: request.body['full'] === true, keepLocal: request.body['keep_local'] === true })));
  },
};

export default entry;
