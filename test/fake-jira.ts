// A fake Jira Cloud site for the tests: the endpoints the plugin calls, over
// a small project held in memory that a test changes between pulls. It
// answers only the email and token below, and counts every request so a test
// can say how few a pull made. Nothing here is a real site, person, or token.
// Run on its own (`node --experimental-strip-types test/fake-jira.ts`) it
// prints its address and serves until stopped, for trying the plugin by hand.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const EMAIL = 'tester@example.com';
export const TOKEN = 'fake-token-not-a-secret';

type Doc = { type: 'doc'; version: 1; content: unknown[] };
const doc = (...content: unknown[]): Doc => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]): unknown => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]): unknown => ({ type: 'text', text, ...(marks ? { marks } : {}) });

export interface FakeUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}
export const ADA: FakeUser = { accountId: '557058:ada', displayName: 'Ada Example', emailAddress: 'ada@example.com' };
export const GRACE: FakeUser = { accountId: '557058:grace', displayName: 'Grace Example' };
export const LIN: FakeUser = { accountId: '557058:lin', displayName: 'Lin Example' };

const STATUSES = {
  todo: { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
  progress: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
  review: { id: '4', name: 'Code Review', statusCategory: { key: 'indeterminate' } },
  done: { id: '5', name: 'Done', statusCategory: { key: 'done' } },
};
const TYPES = {
  epic: { id: '10000', name: 'Epic', subtask: false },
  story: { id: '10001', name: 'Story', subtask: false },
  bug: { id: '10002', name: 'Bug', subtask: false },
  subtask: { id: '10003', name: 'Sub-task', subtask: true },
};

export interface FakeComment {
  id: string;
  author: FakeUser;
  body: Doc;
  created: string;
  updated: string;
  visibility?: { type: string; value: string };
}

export interface FakeIssue {
  id: string;
  key: string;
  fields: Record<string, unknown> & { updated: string; created: string; comments: FakeComment[] };
}

export interface FakeState {
  issues: FakeIssue[];
  // ids filtered out of the scope (moved, deleted, or no longer matching)
  hidden: Set<string>;
  requests: string[];
  // answer the next search with a 429 first
  limitNext: boolean;
}

function issue(id: string, key: string, fields: Record<string, unknown>, comments: FakeComment[] = []): FakeIssue {
  return { id, key, fields: { created: '2026-10-01T09:00:00.000+0000', updated: '2026-10-01T09:00:00.000+0000', ...fields, comments } };
}

export function seed(): FakeState {
  return {
    hidden: new Set(),
    requests: [],
    limitNext: false,
    issues: [
      issue('10100', 'ACME-1', { summary: 'Sign-in epic', issuetype: TYPES.epic, status: STATUSES.progress, priority: { name: 'Medium' }, assignee: null, reporter: ADA, labels: [] }),
      issue(
        '10101',
        'ACME-2',
        {
          summary: 'Ship the login page',
          issuetype: TYPES.story,
          status: STATUSES.review,
          priority: { name: 'High' },
          assignee: ADA,
          reporter: GRACE,
          parent: { id: '10100', key: 'ACME-1' },
          labels: ['web', 'auth'],
          customfield_10020: [{ id: 7, name: 'Sprint 7', state: 'active', endDate: '2026-11-02T00:00:00.000Z' }],
          attachment: [{ id: '20001', filename: 'mockup.png', content: '/secure/attachment/20001/mockup.png', mimeType: 'image/png' }],
          issuelinks: [{ type: { name: 'Blocks' }, outwardIssue: { id: '10102', key: 'ACME-3' } }],
          description: doc(
            { type: 'heading', attrs: { level: 2 }, content: [t('Goal')] },
            p(t('Let people sign in. Ask '), { type: 'mention', attrs: { id: LIN.accountId, text: '@Lin Example' } }, t(' about '), t('SSO', [{ type: 'strong' }]), t('.')),
            {
              type: 'bulletList',
              content: [
                { type: 'listItem', content: [p(t('email and password'))] },
                { type: 'listItem', content: [p(t('a '), t('link', [{ type: 'link', attrs: { href: 'https://example.com/spec' } }]))] },
              ],
            },
            { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('login(user)')] },
            { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'a1b2', type: 'file', collection: 'jira', alt: 'mockup.png' } }] },
          ),
        },
        [
          { id: '30001', author: GRACE, body: doc(p(t('Looks good to me.'))), created: '2026-10-02T10:00:00.000+0000', updated: '2026-10-02T10:00:00.000+0000' },
          {
            id: '30002',
            author: ADA,
            body: doc(p(t('Internal note.'))),
            created: '2026-10-02T11:00:00.000+0000',
            updated: '2026-10-02T11:00:00.000+0000',
            visibility: { type: 'role', value: 'Developers' },
          },
        ],
      ),
      issue('10102', 'ACME-3', { summary: 'Login button is misaligned', issuetype: TYPES.bug, status: STATUSES.todo, priority: { name: 'Low' }, assignee: GRACE, reporter: ADA, labels: [] }),
      issue('10103', 'ACME-4', {
        summary: 'Write the login tests',
        issuetype: TYPES.subtask,
        status: STATUSES.done,
        priority: { name: 'Medium' },
        assignee: null,
        reporter: ADA,
        parent: { id: '10101', key: 'ACME-2' },
        labels: [],
      }),
    ],
  };
}

const FIELDS = (type: { id: string }): unknown[] => [
  { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } },
  { fieldId: 'description', name: 'Description', required: false, schema: { type: 'string', system: 'description' } },
  { fieldId: 'priority', name: 'Priority', required: false, schema: { type: 'priority', system: 'priority' }, allowedValues: [{ name: 'High' }, { name: 'Medium' }, { name: 'Low' }] },
  { fieldId: 'assignee', name: 'Assignee', required: false, schema: { type: 'user', system: 'assignee' } },
  { fieldId: 'labels', name: 'Labels', required: false, schema: { type: 'array', items: 'string', system: 'labels' } },
  ...(type.id === TYPES.subtask.id ? [{ fieldId: 'parent', name: 'Parent', required: true, schema: { type: 'issuelink', system: 'parent' } }] : []),
  { fieldId: 'customfield_10020', name: 'Sprint', required: false, schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
  { fieldId: 'customfield_10016', name: 'Story point estimate', required: false, schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
];

// What one issue looks like in a search: the fields asked for, its comments as the `comment` field.
function shown(held: FakeIssue, fields: string[]): unknown {
  if (fields.length === 1 && fields[0] === 'id') return { id: held.id, key: held.key };
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === 'comment') out['comment'] = { comments: held.fields.comments, total: held.fields.comments.length, maxResults: 5000 };
    else if (field in held.fields) out[field] = held.fields[field];
  }
  return { id: held.id, key: held.key, fields: out };
}

// The JQL the plugin writes, read as far as the fake needs: the project, and an `updated >= "yyyy-MM-dd HH:mm"` in UTC.
function matches(held: FakeIssue, jql: string, state: FakeState): boolean {
  if (state.hidden.has(held.id)) return false;
  if (!/project\s*=\s*"?ACME"?/i.test(jql)) return false;
  const since = /updated\s*>=\s*"(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})"/.exec(jql);
  if (since) return new Date(held.fields.updated.replace('+0000', 'Z')).getTime() >= new Date(`${since[1]}T${since[2]}:00Z`).getTime();
  return true;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
}

export async function startFakeJira(state: FakeState = seed()): Promise<{ url: string; state: FakeState; close(): Promise<void> }> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    state.requests.push(`${request.method} ${url.pathname}`);
    const send = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`)
      return send(401, { errorMessages: ['Client must be authenticated to access this resource.'] });
    const path = url.pathname;
    if (path === '/rest/api/3/myself') return send(200, { accountId: '557058:tester', displayName: 'Tester', emailAddress: EMAIL, timeZone: 'UTC' });
    if (path === '/rest/agile/1.0/board/1/configuration')
      return send(200, {
        filter: { id: '10000' },
        columnConfig: {
          columns: [
            { name: 'To Do', statuses: [{ id: '1' }] },
            { name: 'In Progress', statuses: [{ id: '3' }, { id: '4' }] },
            { name: 'Done', statuses: [{ id: '5' }] },
            // a status the project's own list leaves out, as a board shared with another project's workflow holds
            { name: 'Client Review', statuses: [{ id: '10001' }] },
          ],
        },
      });
    if (path === '/rest/api/3/status/10001') return send(200, { id: '10001', name: 'Client Review', statusCategory: { key: 'indeterminate' } });
    if (path === '/rest/api/3/filter/10000') return send(200, { jql: 'project = ACME ORDER BY Rank ASC' });
    if (path === '/rest/api/3/project/ACME/statuses')
      return send(
        200,
        Object.values(TYPES).map((type) => ({ ...type, statuses: Object.values(STATUSES) })),
      );
    if (path === '/rest/api/3/issue/createmeta/ACME/issuetypes') return send(200, { issueTypes: Object.values(TYPES), total: 4, startAt: 0, maxResults: 50 });
    const meta = /^\/rest\/api\/3\/issue\/createmeta\/ACME\/issuetypes\/(\d+)$/.exec(path);
    if (meta) {
      const type = Object.values(TYPES).find((held) => held.id === meta[1]);
      return type ? send(200, { fields: FIELDS(type), total: FIELDS(type).length, startAt: 0, maxResults: 50 }) : send(404, { errorMessages: ['no such type'] });
    }
    if (path === '/rest/api/3/priority/search') return send(200, { values: [{ name: 'Highest' }, { name: 'High' }, { name: 'Medium' }, { name: 'Low' }], isLast: true });
    if (path === '/rest/api/3/issueLinkType')
      return send(200, {
        issueLinkTypes: [
          { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
          { name: 'Relates', outward: 'relates to', inward: 'relates to' },
          { name: 'Cloners', outward: 'clones', inward: 'is cloned by' },
        ],
      });
    if (path === '/rest/agile/1.0/board/1/sprint') return send(200, { values: [{ id: 7, name: 'Sprint 7', state: 'active', endDate: '2026-11-02T00:00:00.000Z' }], isLast: true });
    if (path === '/rest/api/3/search/jql' && request.method === 'POST') {
      if (state.limitNext) {
        state.limitNext = false;
        return send(429, { errorMessages: ['Rate limited'] }, { 'retry-after': '1' });
      }
      const asked = await body(request);
      const jql = String(asked['jql'] ?? '');
      const fields = Array.isArray(asked['fields']) ? (asked['fields'] as string[]) : ['*all'];
      const max = Math.min(Number(asked['maxResults'] ?? 50), 2);
      const start = Number(asked['nextPageToken'] ?? 0);
      const found = state.issues.filter((held) => matches(held, jql, state));
      const page = found.slice(start, start + max);
      const next = start + max < found.length ? String(start + max) : undefined;
      return send(200, { issues: page.map((held) => shown(held, fields)), ...(next ? { nextPageToken: next } : { isLast: true }) });
    }
    const comments = /^\/rest\/api\/3\/issue\/(\d+)\/comment$/.exec(path);
    if (comments) {
      const held = state.issues.find((candidate) => candidate.id === comments[1]);
      return held ? send(200, { comments: held.fields.comments, total: held.fields.comments.length, startAt: 0, maxResults: 100 }) : send(404, { errorMessages: ['Issue does not exist'] });
    }
    if (/^\/secure\/attachment\/\d+\//.test(path)) {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }
    return send(404, { errorMessages: [`the fake has no ${request.method} ${path}`] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Changes an issue as an edit in Jira does: the fields given, and its `updated` moved on.
export function touch(state: FakeState, key: string, fields: Record<string, unknown>, at: string): void {
  const held = state.issues.find((candidate) => candidate.key === key);
  if (!held) throw new Error(`no fake issue ${key}`);
  Object.assign(held.fields, fields, { updated: at });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeJira();
  console.log(`fake Jira at ${fake.url} (email ${EMAIL}, token ${TOKEN})`);
}
