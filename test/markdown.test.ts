// Markdown to ADF, the way back of the pull's converter: what adf.ts writes
// reads back as the same markdown, a block Jira holds that markdown cannot
// (a panel, a file) goes back as Jira's own node while it is unedited, and
// what an edit would take out of Jira is named.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adfToMarkdown } from '../src/adf.ts';
import { knownOf, lostNodes, markdownToAdf } from '../src/markdown.ts';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });

const SAMPLES = [
  '# Goal\n\nMake the **login** page *faster*, with `code` and ~~old~~ text.',
  '- one\n- two\n\n  - nested\n- three',
  '1. first\n2. second\n\n   more of the second',
  '- [ ] open item\n- [x] done item',
  '```ts\nconst a = 1;\nconst b = 2;\n```',
  '> a quote\n>\n> its second paragraph',
  '| Name | Value |\n| --- | --- |\n| a | 1 |\n| b \\| c | 2 |',
  'A [link](https://example.com/a) and <https://example.com/card> here.',
  'line one  \nline two',
  '---',
  '**Goal:** 1-1 recreation of the search tab\n\n**Workflow Expectations:**\n\n- Use the live application\n- Check the Figma design',
];

test('Jira Sync: the markdown adf.ts writes reads back as the same markdown', () => {
  for (const sample of SAMPLES) assert.equal(adfToMarkdown(markdownToAdf(sample)), sample, sample);
});

test('Jira Sync: a document Jira holds reads to markdown and back to the same markdown', () => {
  const held = doc(
    { type: 'heading', attrs: { level: 2 }, content: [t('Steps')] },
    { type: 'orderedList', attrs: { order: 1 }, content: [{ type: 'listItem', content: [p(t('Open '), t('Shows', [{ type: 'strong' }]))] }] },
    p(t('see '), t('the doc', [{ type: 'link', attrs: { href: 'https://example.com' } }])),
  );
  const markdown = adfToMarkdown(held);
  assert.equal(adfToMarkdown(markdownToAdf(markdown)), markdown);
});

test('Jira Sync: an unedited panel, file, and mention go back as Jira holds them, and an edit elsewhere loses none', () => {
  const mention = { type: 'mention', attrs: { id: '557058:ada', text: '@Ada Example' } };
  const panel = { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Heads up'))] };
  const file = { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1', type: 'file', collection: 'c' } }] };
  const held = doc(p(t('Ask '), mention, t(' first.')), panel, file, p(t('Old ending.')));
  const context = { mention: () => null, media: () => ({ label: 'shot.png', href: 'https://acme.atlassian.net/rest/api/3/attachment/content/1' }) };
  const markdown = adfToMarkdown(held, context);
  const edited = markdown.replace('Old ending.', 'New ending.');
  const sent = markdownToAdf(edited, knownOf(held, context));
  assert.deepEqual(sent.content[0], held.content[0]);
  assert.deepEqual(sent.content[1], panel);
  assert.deepEqual(lostNodes(held, sent), []);
  assert.equal(adfToMarkdown(sent, context), edited);
});

test('Jira Sync: a block that reads as nothing (a file with no name known) is named as lost, never dropped unseen', () => {
  const file = { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1', type: 'file', collection: 'c' } }] };
  const held = doc(p(t('Text.')), file);
  const sent = markdownToAdf(adfToMarkdown(held), knownOf(held));
  assert.deepEqual(lostNodes(held, sent), [{ kind: 'media', count: 1 }, { kind: 'mediaSingle', count: 1 }]);
});

test('Jira Sync: a mention kept in an edited paragraph stays a mention; a rewritten panel is named as lost', () => {
  const mention = { type: 'mention', attrs: { id: '557058:ada', text: '@Ada Example' } };
  const held = doc(p(t('Ask '), mention, t(' first.')), { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Heads up'))] });
  const markdown = adfToMarkdown(held);
  const edited = markdown.replace('first.', 'before Friday.').replace('Heads up', 'Heads up, changed');
  const sent = markdownToAdf(edited, knownOf(held));
  assert.deepEqual((sent.content[0] as { content: unknown[] }).content[1], mention);
  assert.deepEqual(lostNodes(held, sent), [{ kind: 'panel', count: 1 }]);
});

test('Jira Sync: Jira text that markdown would read otherwise (a number and a dot, stars, underscores, a fence, parentheses in an address) goes back as the same document', () => {
  const held = doc(
    p(t('1. Not a list')),
    p(t('2026. was a year')),
    p(t('2*3*4 and a * b * c and snake_case_name and _wrapped_ and ~~not struck~~')),
    p(t('see '), t('wiki', [{ type: 'link', attrs: { href: 'https://example.com/Foo_(bar)' } }]), t(' now')),
    p(t('- not a bullet')),
    { type: 'codeBlock', attrs: { language: 'md' }, content: [t('```\ninside\n```')] },
  );
  const markdown = adfToMarkdown(held);
  assert.deepEqual(markdownToAdf(markdown).content, held.content, markdown);
});
