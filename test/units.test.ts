// The pure parts on their own: ADF to markdown, the mapping's defaults and
// checks, the JQL moment, the site address, and a Jira time as a task's date.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adfToMarkdown } from '../src/adf.ts';
import { siteBase } from '../src/client.ts';
import { fromBoardUrl, opposed, readConnection, type Connection } from '../src/connections.ts';
import type { Description } from '../src/describe.ts';
import { checkMapping, compactFields, draftMapping, editorModel, fieldsFor, priorityFor, statusFor, typeFor } from '../src/mapping.ts';
import { jqlMoment, moment } from '../src/pull.ts';
import type { BoardSettings } from '../src/types.ts';

const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });

test('Jira Pull REQ7: a document reads as markdown, a mention as the alias, a file as its link, and an unknown node as its text', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 3 }, content: [text('Title')] },
      para(text('bold', [{ type: 'strong' }]), text(' and '), text('code', [{ type: 'code' }]), text(' by '), { type: 'mention', attrs: { id: 'acc-1', text: '@Ada' } }),
      {
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [para(text('one'))] },
          { type: 'listItem', content: [para(text('two'))] },
        ],
      },
      { type: 'blockquote', content: [para(text('quoted'))] },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [para(text('a'))] },
              { type: 'tableHeader', content: [para(text('b'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [para(text('1'))] },
              { type: 'tableCell', content: [para(text('2|3'))] },
            ],
          },
        ],
      },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1', alt: 'shot.png' } }] },
      { type: 'somethingNew', content: [para(text('still read'))] },
    ],
  };
  const out = adfToMarkdown(doc, { mention: (id) => (id === 'acc-1' ? 'ada' : null), media: (_id, alt) => (alt ? { label: alt, href: `files/${alt}` } : null) });
  assert.equal(out, ['### Title', '**bold** and `code` by @ada', '1. one\n2. two', '> quoted', '| a | b |\n| --- | --- |\n| 1 | 2\\|3 |', '[shot.png](files/shot.png)', 'still read'].join('\n\n'));
  assert.equal(
    adfToMarkdown(
      { type: 'doc', content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm', alt: 'a.png' } }] }] },
      { mention: () => null, media: () => ({ label: 'a.png', href: '../assets/a.png', image: true }) },
    ),
    '![a.png](../assets/a.png)',
    'an image in the root is written as an image',
  );
  assert.equal(adfToMarkdown(null), '');
  assert.equal(adfToMarkdown('plain'), 'plain');
});

const BOARD: BoardSettings = {
  statuses: ['Backlog', 'To Do', 'In Progress', 'In Review', 'Done'],
  columns: [
    { name: 'To Do', statuses: ['To Do'] },
    { name: 'In Progress', statuses: ['In Progress'] },
    { name: 'In Review', statuses: ['In Review'] },
    { name: 'Done', statuses: ['Done'] },
  ],
  default_status: 'Backlog',
  priorities: ['high', 'medium', 'low'],
  milestones: [],
  properties: [
    { name: 'points', type: 'Number', options: null },
    { name: 'team', type: 'Text', options: ['web', 'api'] },
  ],
  sections: [{ key: 'description', title: 'Description', type: 'text' }],
  types: [
    { name: 'default', title: 'Task', sections: [{ key: 'description', title: 'Description', type: 'text' }], prefix: null },
    { name: 'bug', title: 'Bug', sections: [], prefix: 'B' },
  ],
  status_categories: {},
  link_types: [{ name: 'blocks', outward: 'blocks', inward: 'is blocked by' }],
};

const connection = (mapping: Connection['mapping'] = {}, direction: 'pull' | 'push' = 'pull'): Connection => ({ name: 'acme', site: 'acme.atlassian.net', project: 'ACME', direction, mapping });

test('Jira REQ11: a status not mapped goes by its name, else to the first Backlog status of its category; a type a given types part leaves out is not carried', () => {
  assert.equal(statusFor({}, BOARD, 'In Review', 'in_progress'), 'In Review');
  assert.equal(statusFor({}, BOARD, 'QA', 'in_progress'), 'In Progress');
  assert.equal(statusFor({}, BOARD, 'Closed', 'done'), 'Done');
  assert.equal(statusFor({}, BOARD, 'Open', 'todo'), 'Backlog');
  assert.equal(statusFor({ statuses: [{ jira: 'QA', eidos: 'In Review' }] }, BOARD, 'QA', 'in_progress'), 'In Review');
  assert.equal(typeFor({}, BOARD, 'Bug'), 'bug');
  assert.equal(typeFor({}, BOARD, 'Story'), 'default');
  assert.equal(typeFor({ types: [{ jira: 'Bug', eidos: 'bug' }] }, BOARD, 'Story'), null);
  assert.equal(priorityFor({}, BOARD, 'High'), 'high');
  assert.equal(priorityFor({}, BOARD, 'Highest'), null);
});

const DESCRIPTION: Description = {
  connection: 'acme',
  read: '2026-10-27T00:00:00Z',
  columns: [],
  priorities: ['High'],
  link_types: [{ name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }],
  sprints: [],
  filter: null,
  sprint_field: 'customfield_10020',
  types: [
    {
      id: '1',
      name: 'Story',
      subtask: false,
      statuses: [{ id: '1', name: 'QA', category: 'in_progress' }],
      fields: [
        { id: 'customfield_10016', name: 'Story points', type: 'number', required: false },
        { id: 'customfield_10030', name: 'Team', type: 'option', required: false, allowed: ['web', 'mobile'] },
      ],
    },
  ],
};

test('Jira REQ9, REQ10: a pair is checked against its types, a property’s options, the Backlog’s names, and the direction', () => {
  const codes = (mapping: Connection['mapping'], direction: 'pull' | 'push' = 'pull') => checkMapping(connection(mapping, direction), BOARD, DESCRIPTION).map((problem) => problem.code);
  assert.deepEqual(codes({ fields: [{ jira: 'customfield_10016', eidos: 'property:points' }] }), []);
  assert.deepEqual(codes({ fields: [{ jira: 'customfield_10016', eidos: 'title' }] }), ['pair-type']);
  assert.deepEqual(codes({ fields: [{ jira: 'customfield_10030', eidos: 'property:team' }] }), ['option-missing']);
  assert.deepEqual(codes({ fields: [{ jira: 'summary', eidos: 'property:nope' }] }), ['target-unknown']);
  assert.deepEqual(codes({ fields: [{ jira: 'created', eidos: 'property:points' }] }, 'push'), ['direction', 'pair-type']);
  assert.deepEqual(codes({ statuses: [{ jira: 'QA', eidos: 'Nope' }] }), ['target-unknown']);
});

test('Jira REQ12: a draft matches names and categories and proposes the sprint field as the milestone', () => {
  const { entries } = draftMapping(connection(), BOARD, DESCRIPTION);
  const find = (part: string, jira: string) => entries.find((entry) => entry.part === part && entry.jira === jira)?.eidos;
  assert.equal(find('statuses', 'QA'), 'In Progress');
  assert.equal(find('link_types', 'Blocks'), 'blocks');
  assert.equal(find('fields', 'customfield_10020'), 'milestone');
});

test('Jira REQ12: a priority with no Backlog priority of its name is drafted by its rank, and a sub-task type is drafted to the default type', () => {
  const description: Description = {
    ...DESCRIPTION,
    priorities: ['Urgent', 'Moderate', 'Medium', 'Deferred'],
    types: [...DESCRIPTION.types, { id: '10003', name: 'Sub-task', subtask: true, statuses: [], fields: [] }],
  };
  const { entries, unmatched } = draftMapping(connection(), BOARD, description);
  const entry = (part: string, jira: string) => entries.find((held) => held.part === part && held.jira === jira);
  assert.deepEqual(
    ['Urgent', 'Moderate', 'Medium', 'Deferred'].map((name) => [name, entry('priorities', name)?.eidos, entry('priorities', name)?.why]),
    [
      ['Urgent', 'high', 'by rank (1 of 4)'],
      ['Moderate', 'medium', 'by rank (2 of 4)'],
      ['Medium', 'medium', 'same name'],
      ['Deferred', 'low', 'by rank (4 of 4)'],
    ],
    "past the Backlog's last, the lowest",
  );
  assert.equal(entry('types', 'Sub-task')?.eidos, 'default', 'a sub-task type is carried, filed by the parent rule');
  assert.deepEqual(
    unmatched.filter((line) => /priority|Sub-task/.test(line)),
    [],
  );
  assert.match(draftMapping(connection(), { ...BOARD, priorities: [] }, description).unmatched.join('\n'), /priority Urgent: the Backlog has no priorities/);
});

const TWO_TYPES: Description = {
  ...DESCRIPTION,
  types: [
    ...DESCRIPTION.types,
    {
      id: '2',
      name: 'Epic',
      subtask: false,
      statuses: [{ id: '2', name: 'Intake', category: 'todo' }],
      fields: [
        { id: 'customfield_10016', name: 'Story points', type: 'number', required: false },
        { id: 'customfield_10040', name: 'Target', type: 'date', required: false },
      ],
    },
  ],
};

test('Jira REQ7: a field pair naming an issue type holds for it alone and wins over the pair for every type', () => {
  const pairs = [
    { jira: 'customfield_10016', eidos: 'property:points' },
    { jira: 'customfield_10016', eidos: 'section:description', types: ['epic'] },
    { jira: 'customfield_10040', eidos: 'property:points', types: ['Epic'] },
  ];
  assert.deepEqual(
    fieldsFor(pairs, 'Story').map((pair) => pair.eidos),
    ['property:points'],
  );
  assert.deepEqual(
    fieldsFor(pairs, 'Epic').map((pair) => `${pair.jira} ${pair.eidos}`),
    ['customfield_10016 section:description', 'customfield_10040 property:points'],
  );
  const codes = (fields: Connection['mapping']['fields']) => checkMapping(connection({ fields }), BOARD, TWO_TYPES).map((problem) => problem.message);
  assert.deepEqual(codes([{ jira: 'customfield_10016', eidos: 'property:points', types: ['Epic'] }]), [], 'a field the Epic holds');
  assert.match(codes([{ jira: 'customfield_10040', eidos: 'property:points', types: ['Story'] }]).join('\n'), /the issue type Story has no field customfield_10040/);
  assert.match(codes([{ jira: 'summary', eidos: 'title', types: ['Task'] }]).join('\n'), /the project has no issue type Task/);
});

test('Jira REQ12: the editor starts from the held pairs, else the suggestions, and saves a field the types share as one pair', () => {
  const fresh = editorModel(connection(), BOARD, TWO_TYPES);
  assert.equal(fresh.chosen.statuses['Intake'], 'Backlog', 'a status by its category');
  assert.equal(fresh.chosen.types['Epic'], 'default');
  assert.ok(
    fresh.types[1]!.fields.some((field) => field.id === 'status'),
    'every type has a status',
  );
  assert.deepEqual(fresh.types[1]!.fields.find((field) => field.id === 'customfield_10040')?.property, { type: 'Date' });
  assert.ok(!fresh.types[0]!.fields.find((field) => field.id === 'customfield_10016')!.targets.includes('title'), 'a number never goes to the title');
  const held = editorModel(connection({ types: [{ jira: 'Story', eidos: 'bug' }], statuses: [{ jira: 'Intake', eidos: 'Done' }] }), BOARD, TWO_TYPES);
  assert.equal(held.chosen.types['Story'], 'bug');
  assert.equal(held.chosen.types['Epic'], '', 'a type the held part leaves out is not carried');
  assert.equal(held.chosen.statuses['Intake'], 'Done', 'any status may go anywhere');

  const same = compactFields(
    [
      { type: 'Story', jira: 'customfield_10016', eidos: 'property:points' },
      { type: 'Epic', jira: 'customfield_10016', eidos: 'property:points' },
    ],
    fresh,
    [{ jira: 'customfield_99999', eidos: 'property:team' }],
  );
  assert.deepEqual(same, [
    { jira: 'customfield_99999', eidos: 'property:team' },
    { jira: 'customfield_10016', eidos: 'property:points' },
  ]);
  assert.deepEqual(
    compactFields(
      [
        { type: 'Story', jira: 'customfield_10016', eidos: 'property:points' },
        { type: 'Epic', jira: 'customfield_10016', eidos: 'section:description' },
      ],
      fresh,
      [],
    ),
    [
      { jira: 'customfield_10016', eidos: 'property:points', types: ['Story'] },
      { jira: 'customfield_10016', eidos: 'section:description', types: ['Epic'] },
    ],
  );
});

test('Jira REQ2, REQ3: a connection is read forgivingly, and one the other way over the same project is found', () => {
  assert.equal(readConnection({ name: 'x' }), null);
  const pull = readConnection({ name: 'a', site: 'acme.atlassian.net', project: 'acme', direction: 'pull' })!;
  assert.equal(pull.project, 'ACME');
  const push = readConnection({ name: 'b', site: 'https://ACME.atlassian.net/', project: 'ACME', direction: 'push' })!;
  assert.equal(opposed([pull, push], push)?.name, 'a');
});

test('Jira REQ16, Jira Pull REQ3: a site is a Jira Cloud address; a watermark is written in the person’s zone; a Jira time keeps its offset', () => {
  assert.equal(siteBase('Acme.atlassian.net'), 'https://acme.atlassian.net');
  assert.equal(siteBase('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.throws(() => siteBase('evil.example.com'), /not a Jira Cloud site/);
  assert.equal(jqlMoment(new Date('2026-10-27T03:04:00Z'), 'America/Sao_Paulo'), '2026-10-27 00:04');
  assert.equal(moment('2026-10-01T09:00:00.123+0530'), '2026-10-01T09:00:00+05:30');
  assert.equal(moment('2026-10-01T09:00:00Z'), '2026-10-01T09:00:00+00:00');
});

test("Jira REQ2: a board's address as Jira shows it reads as its site, project, and board; anything else is not one", () => {
  assert.deepEqual(fromBoardUrl('https://acme.atlassian.net/jira/software/projects/acme/boards/12?selectedIssue=ACME-1'), { site: 'acme.atlassian.net', project: 'ACME', board: 12 });
  assert.deepEqual(fromBoardUrl('https://acme.atlassian.net/jira/software/projects/ACME/list'), { site: 'acme.atlassian.net', project: 'ACME', board: null });
  assert.equal(fromBoardUrl('acme.atlassian.net'), null);
  assert.equal(fromBoardUrl('https://acme.atlassian.net/wiki/spaces/X'), null);
});

test('Jira Sync REQ18: two texts split into the lines both hold and the conflicts between them, each settled by its pick', async () => {
  const { mergeText, segmentsOf } = await import('../src/merge.ts');
  const segments = segmentsOf('- [ ] #1 Shared\n- [ ] #2 From Jira!', '- [ ] #1 Shared\n- [ ] #2 From Eidos');
  assert.deepEqual(segments, [
    { kind: 'shared', lines: ['- [ ] #1 Shared'] },
    { kind: 'conflict', jira: ['- [ ] #2 From Jira!'], here: ['- [ ] #2 From Eidos'] },
  ]);
  assert.equal(
    mergeText(segments, () => 'both'),
    '- [ ] #1 Shared\n- [ ] #2 From Jira!\n- [ ] #2 From Eidos',
  );
  assert.equal(
    mergeText(segments, () => 'eidos'),
    '- [ ] #1 Shared\n- [ ] #2 From Eidos',
  );
  assert.equal(
    mergeText(segmentsOf('a\nb\nc', 'a\nc'), () => 'jira'),
    'a\nb\nc',
    'a line only one side holds is a conflict too, kept only when picked',
  );
  assert.equal(
    mergeText(segmentsOf('a\nb\nc', 'a\nc'), () => 'eidos'),
    'a\nc',
  );
});

test('Jira Sync REQ19, REQ20: auto sync waits for a task’s saves to settle, syncs what was edited here once a push is heard, and puts what it stops on in Needs you', async (t) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { readNeeds, startAutoSync } = await import('../src/autosync.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settings: Record<string, boolean> = { auto_sync_on_save: false, auto_sync_on_push: false };
  let saved: (paths: string[]) => void = () => undefined;
  let pushed: (target: string | null) => void = () => undefined;
  const events: Array<[string, unknown]> = [];
  const host = {
    workspace: mkdtempSync(path.join(tmpdir(), 'jira-auto-')),
    settings: () => ({ get: (name: string) => settings[name] }),
    files: { on: (_event: string, listener: (paths: string[]) => void) => void (saved = listener) },
    emit: (event: string, payload: unknown) => void events.push([event, payload]),
    plugin: () => ({ onPush: (listener: (target: string | null) => void) => ((pushed = listener), () => undefined) }),
  };
  const synced: string[] = [];
  const refuse = new Set<string>(['T-2']);
  const api = {
    syncStatus: () => [
      {
        connection: 'acme',
        edited: [
          { task: 'T-1', key: 'ACME-1', sides: ['title'] },
          { task: 'T-2', key: 'ACME-2', sides: ['status'] },
        ],
        pending: [],
        interrupted: [],
      },
    ],
    taskAt: (file: string) =>
      file === 'backlog/t-1.md'
        ? { task: 'T-1', title: 'One', key: 'ACME-1', url: null, connection: 'acme', pending: false, skipped: false }
        : file === 'backlog/t-3.md'
          ? { task: 'T-3', title: 'Three', key: 'ACME-3', url: null, connection: 'acme', pending: false, skipped: true }
          : null,
    syncPlan: async (task: string) => ({ blockers: refuse.has(task) ? [{ side: 'section:acceptance-criteria', code: 'conflict', message: 'raw', fix: '' }] : [] }),
    sync: async (task: string) => {
      synced.push(task);
      return {};
    },
  };
  const stop = startAutoSync(host as never, api as never);
  const settle = async (): Promise<void> => {
    t.mock.timers.tick(5_000);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  saved(['backlog/t-1.md']);
  await settle();
  assert.deepEqual(synced, [], 'off by default: a save syncs nothing');

  settings['auto_sync_on_save'] = true;
  saved(['backlog/t-1.md']);
  t.mock.timers.tick(3_000);
  saved(['backlog/t-1.md', 'backlog/t-3.md']);
  await settle();
  assert.deepEqual(synced, ['T-1'], 'a run of saves is one sync, and a task marked Don’t sync is left alone');

  synced.length = 0;
  pushed('origin/main');
  await settle();
  assert.deepEqual(synced, [], 'a push syncs nothing while that switch is off');
  settings['auto_sync_on_push'] = true;
  pushed('origin/main');
  await settle();
  assert.deepEqual(synced, ['T-1'], 'a push syncs every task edited here, one at a time, and writes nothing for one with anything to settle');
  assert.deepEqual(
    readNeeds(host.workspace).map((need) => [need.task, need.key, need.reason]),
    [['T-2', 'ACME-2', 'Acceptance criteria: changed in Jira and here']],
  );
  assert.equal(events.filter(([event]) => event === 'needs').length, 1);
  pushed('origin/main');
  await settle();
  assert.equal(events.filter(([event]) => event === 'needs').length, 1, 'a task still waiting for the same reason is not announced again');
  stop();
});
