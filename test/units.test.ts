// The pure parts on their own: ADF to markdown, the mapping's defaults and
// checks, the JQL moment, the site address, and a Jira time as a task's date.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adfToMarkdown } from '../src/adf.ts';
import { siteBase } from '../src/client.ts';
import { opposed, readConnection, type Connection } from '../src/connections.ts';
import type { Description } from '../src/describe.ts';
import { checkMapping, draftMapping, priorityFor, statusFor, typeFor } from '../src/mapping.ts';
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
