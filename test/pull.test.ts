// The plugin end to end: built, installed under an app data folder of the
// test's own, switched on and allowed in a scratch root, and driven through
// the Eidos CLI against the fake Jira. EIDOS_CLI names the CLI to run (its
// `dist/src/cli.js`); without it, the eidosmd this repository installs.
// Secrets go to a JSON file standing in for the credential store.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMAIL, startFakeJira, TOKEN, touch } from './fake-jira.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliFile = process.env['EIDOS_CLI'] ?? path.join(repo, 'node_modules', 'eidosmd', 'dist', 'src', 'cli.js');
const version = /^version:\s*(\S+)/m.exec(readFileSync(path.join(repo, 'manifest.yaml'), 'utf8'))![1]!;

const scratch = mkdtempSync(path.join(tmpdir(), 'eidos-jira-'));
const env = { ...process.env, EIDOS_APP_DATA: path.join(scratch, 'app'), EIDOS_NO_TELEMETRY: '1', JIRA_EMAIL: '', JIRA_API_TOKEN: '' };
const TOKENS = path.join(env.EIDOS_APP_DATA, 'plugins', 'jira', 'credentials.json');
const root = path.join(scratch, 'Blueprints');
let fake: Awaited<ReturnType<typeof startFakeJira>>;

// run without blocking, since the fake Jira answers from this same process
function eidos(args: string[], input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], { cwd: existsSync(root) ? root : scratch, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}
const ok = async (args: string[], input?: string): Promise<string> => {
  const result = await eidos(args, input);
  assert.equal(result.status, 0, `eidos ${args.join(' ')}\n${result.stderr}${result.stdout}`);
  return result.stdout;
};

// a moment as Jira writes one, a little after now, each later than the last, so an edit lands after the last pull's watermark
let tick = 0;
const jiraNow = (): string => new Date(Date.now() + 60_000 + (tick += 1) * 1000).toISOString().replace('Z', '+0000');

const backlog = (): string => path.join(root, 'backlog');
const taskFile = (prefix: string): string =>
  path.join(
    backlog(),
    readdirSync(backlog()).find((name) => name.startsWith(prefix))!,
  );
const snapshot = (): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (file !== path.join(root, '.eidos', 'plugins', 'jira', 'local')) walk(file);
      } else out.set(path.relative(root, file), readFileSync(file, 'utf8'));
    }
  };
  walk(root);
  return out;
};
const changedFiles = (a: Map<string, string>, b: Map<string, string>): string[] => [...new Set([...a.keys(), ...b.keys()])].filter((file) => a.get(file) !== b.get(file)).sort();

before(async () => {
  fake = await startFakeJira();
  // the release as `eidos plugin install` places it
  const dir = path.join(scratch, 'app', 'plugins', 'jira', version);
  mkdirSync(dir, { recursive: true });
  // only the files a Registry listing pins, as a Registry install downloads them; the guide rides in the manifest
  for (const file of ['manifest.yaml', 'cli.js']) copyFileSync(path.join(repo, 'dist', file), path.join(dir, file));
  // a CLI built from source still carries the last release's version, so the copy asks for the CLI under test; the release keeps its min_host
  const cliVersion = /eidosmd (\S+)/.exec(await ok(['--version']))?.[1] ?? '';
  const manifest = path.join(dir, 'manifest.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^min_host: .*$/m, `min_host: ${cliVersion}`));
  await ok(['install', '--blank', root, '--product', 'Scratch', '--yes', '--offline']);
  await ok(['plugin', 'enable', 'backlog']);
  await ok(['plugin', 'enable', 'assets']);
  await ok(['plugin', 'enable', 'jira']);
  await ok(['plugin', 'allow', 'jira']);
});

after(async () => {
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
});

test('the plugin is listed and loads once allowed, its guide and its command mounted', async () => {
  const listed = (JSON.parse(await ok(['plugin', '--json'])) as Array<{ name: string; enabled: boolean; version: string; error: string | null }>).find((entry) => entry.name === 'jira');
  assert.equal(listed?.enabled, true, listed?.error ?? '');
  assert.equal(listed?.version, version);
  assert.match(await ok(['jira', '--help']), /fetch/);
  assert.match(await ok(['instructions', 'jira']), /eidos jira pull/);
});

test('Jira REQ5, REQ19: login checks the token against Jira and keeps it only in the credentials file; a wrong one is refused', async () => {
  const refused = await eidos(['jira', 'login', fake.url], `${EMAIL}\nnot-the-token\n`);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /did not accept that email and token/);
  assert.equal(existsSync(TOKENS), false, 'nothing kept for a refused sign-in');
  assert.match(await ok(['jira', 'login', fake.url], `${EMAIL}\n${TOKEN}\n`), /Signed in to .* as Tester \(tester@example.com\), kept for this root/);
  assert.equal(JSON.parse(readFileSync(TOKENS, 'utf8')).tokens[`${fake.url}/${EMAIL}`], TOKEN);
  if (process.platform !== 'win32') assert.equal(statSync(TOKENS).mode & 0o777, 0o600, 'the credentials file is readable only by its owner');
  for (const file of [path.join(root, '.eidos', 'plugins', 'jira', 'settings.yaml'), path.join(root, '.eidos', 'plugins', 'jira', 'local.yaml')])
    if (existsSync(file)) assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(TOKEN), `${file} holds no token`);
});

test('Jira REQ2, REQ3: a connection is written to the shared settings; another over the same project the other way is refused', async () => {
  await ok(['jira', 'connect', 'acme', '--site', fake.url, '--key', 'ACME', '--board', '1']);
  const refused = await eidos(['jira', 'connect', 'acme-out', '--site', fake.url, '--key', 'ACME', '--direction', 'push']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /never pulls and pushes the same issues/);
  assert.match(await ok(['jira', 'whoami']), /tester@example.com, kept for this root/);
});

test('Jira REQ6, REQ12: describe reads the board and keeps it in local/; map drafts by names and categories and writes only what is accepted', async () => {
  const described = JSON.parse(await ok(['jira', 'describe', 'acme', '--json'])) as { columns: Array<{ name: string; statuses: string[] }>; types: Array<{ name: string }>; sprint_field: string };
  assert.deepEqual(described.columns.at(-1), { name: 'Client Review', statuses: ['Client Review'] }, "a column's status the project's list leaves out is named, not left as its id");
  assert.deepEqual(
    described.types.map((type) => type.name),
    ['Epic', 'Story', 'Bug', 'Sub-task'],
  );
  assert.equal(described.sprint_field, 'customfield_10020');
  assert.ok(existsSync(path.join(root, '.eidos', 'plugins', 'jira', 'local', 'describe-acme.json')));
  const drafted = await ok(['jira', 'map', 'acme']);
  assert.match(drafted, /statuses: Code Review → In Progress \(same category \(in_progress\)\)/);
  assert.match(drafted, /priorities: Highest → high \(by rank \(1 of 4\)\)/);
  assert.match(drafted, /types: Sub-task → default/);
  assert.match(drafted, /Nothing written/);
  assert.doesNotMatch(readFileSync(path.join(root, '.eidos', 'plugins', 'jira', 'settings.yaml'), 'utf8'), /statuses/);
  await ok(['jira', 'map', 'acme', '--yes']);
  assert.match(readFileSync(path.join(root, '.eidos', 'plugins', 'jira', 'settings.yaml'), 'utf8'), /jira: Sub-task\n\s+eidos: default/);
});

test('Jira REQ9: a pair that cannot be carried is a jira/ finding with what to do', async () => {
  const out = await ok(['jira', 'configure:map', 'acme', 'set', 'fields', 'customfield_10016', 'title']);
  assert.match(out, /jira\/pair-type: .*a number field is not carried into the title; change the pair/);
  assert.match((await eidos(['check'])).stdout, /jira\/pair-type/);
  await ok(['jira', 'configure:map', 'acme', 'unset', 'fields', 'customfield_10016']);
});

test('Jira REQ7: a field pair can hold for some issue types alone, and unsetting it for them leaves the rest', async () => {
  const file = path.join(root, '.eidos', 'plugins', 'jira', 'settings.yaml');
  const before = readFileSync(file, 'utf8');
  assert.match(await ok(['jira', 'configure:map', 'acme', 'set', 'fields', 'duedate', 'title', '--types', 'Epic,Story']), /fields duedate → title \(Epic, Story\)/);
  await ok(['jira', 'configure:map', 'acme', 'unset', 'fields', 'duedate', '--types', 'Story']);
  assert.match(readFileSync(file, 'utf8'), /jira: duedate\n\s+eidos: title\n\s+types:\n\s+- Epic\n(?!\s+- Story)/);
  await ok(['jira', 'configure:map', 'acme', 'unset', 'fields', 'duedate']);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('Jira Pull REQ1, REQ2, REQ4, REQ7 to REQ10: a fetch writes nothing; a pull writes each issue as a task with its key for an id, its comments as a thread signed by the Jira names, adding no user', async () => {
  await ok(['users', 'add', 'Ada Example', '--alias', 'ada']);
  const before = snapshot();
  const fetched = await ok(['jira', 'fetch']);
  assert.match(fetched, /4 issues to add/);
  assert.match(fetched, /\+ ACME-2 {2}Ship the login page/);
  assert.match(fetched, /milestones to add: Sprint 7/);
  assert.deepEqual(changedFiles(before, snapshot()), [], 'a fetch writes nothing to the root');

  fake.state.limitNext = true;
  assert.match(await ok(['jira', 'pull']), /acme: 4 added, 0 changed, comments 1 added, 0 changed, 0 removed\n/);
  const story = readFileSync(taskFile('t-acme-2-ship'), 'utf8');
  assert.match(story, /^id: T-ACME-2$/m, 'the id is drawn from the key');
  assert.match(story, /^status: In Progress$/m, 'Code Review by its mapping');
  assert.match(story, /^milestone: Sprint 7$/m);
  assert.match(story, /^assignee: \["ada"\]$/m, 'the root user of the same name');
  assert.match(story, /key: ACME-2/);
  assert.match(story, /parent: ACME-1/, "an epic's child keeps its epic in its jira key under the subtasks rule");
  assert.match(story, /Ask @Lin Example about \*\*SSO\*\*\./, 'a mention of someone the root does not have reads as Jira names them');
  assert.match(story, /(?<!!)\[mockup\.png\]\(http:\/\/127\.0\.0\.1:\d+\/rest\/api\/3\/attachment\/content\/20001\)/, 'an attachment is linked to in Jira by default, a link and not an image');
  assert.match(story, /links:\n {2}- \{ type: blocks, task: T-ACME-3 \}/);
  assert.match(story, /^updated: 2026-10-01T09:00:00\+00:00$/m, "Jira's time, not the pull's");
  const subtask = readFileSync(taskFile('t-acme-2-1-'), 'utf8');
  assert.match(subtask, /^parent: T-ACME-2$/m, 'a sub-task is the subtask of its parent');
  const thread = readFileSync(path.join(root, '.eidos', 'plugins', 'comments', 'threads', 't-jira-10101.yaml'), 'utf8');
  assert.match(thread, /author: Grace Example\n\s+at: 2026-10-02T10:00:00.000Z\n\s+external: jira:30001/);
  assert.doesNotMatch(thread, /Internal note/, 'a restricted comment is not pulled');
  const users = await ok(['users', 'list']);
  assert.doesNotMatch(users, /Grace Example|Lin Example/, "a pull adds nobody to the root's users");
  assert.ok(fake.state.requests.filter((request) => request.startsWith('POST /rest/api/3/search/jql')).length >= 2, 'the limited search was asked again');
});

test('Jira Pull REQ16, REQ3, REQ15: a pull with nothing changed writes no file, and a later one asks only for what changed', async () => {
  const before = snapshot();
  const requests = fake.state.requests.length;
  assert.match(await ok(['jira', 'pull']), /0 added, 0 changed/);
  assert.match(await ok(['jira', 'pull', '--full']), /0 added, 0 changed/);
  assert.deepEqual(changedFiles(before, snapshot()), []);
  const asked = fake.state.requests.slice(requests);
  assert.equal(asked.filter((request) => request.includes('/comment')).length, 0, 'no comments read when none changed');
});

test('Jira Pull REQ5, D-C07: a change in Jira is shown and pulled; an edit in the root to a mapped field is named, overwritten by a pull, and kept with --keep-local', async () => {
  touch(fake.state, 'ACME-3', { summary: 'Login button is misaligned on mobile', priority: { name: 'High' } }, jiraNow());
  await ok(['backlog', 'set', 'T-ACME-3', '--status', 'In Progress']);
  const fetched = await ok(['jira', 'fetch']);
  assert.match(fetched, /~ ACME-3 {2}T-ACME-3: .*title/);
  assert.match(fetched, /! ACME-3 {2}T-ACME-3 was edited here: status/);
  assert.match(await ok(['jira', 'pull', '--keep-local']), /1 changed, 1 kept local edits/);
  let bug = readFileSync(taskFile('t-acme-3-'), 'utf8');
  assert.match(bug, /^title: Login button is misaligned on mobile$/m);
  assert.match(bug, /^priority: high$/m);
  assert.match(bug, /^status: In Progress$/m, 'the local edit kept');
  touch(fake.state, 'ACME-3', { summary: 'Login button is misaligned on phones' }, jiraNow());
  assert.match(await ok(['jira', 'fetch']), /was edited here: status/, 'still named until a pull without --keep-local');
  await ok(['jira', 'pull']);
  bug = readFileSync(taskFile('t-acme-3-'), 'utf8');
  assert.match(bug, /^status: To Do$/m, 'Jira wins');
});

test('Jira Pull REQ6: what the mapping leaves alone is never touched', async () => {
  await ok(['backlog', 'set', 'T-ACME-2', '--body', 'implementation-notes=Found the bug in the form.']);
  touch(fake.state, 'ACME-2', { summary: 'Ship the login page now' }, jiraNow());
  await ok(['jira', 'pull']);
  const story = readFileSync(taskFile('t-acme-2-ship'), 'utf8');
  assert.match(story, /^title: Ship the login page now$/m);
  assert.match(story, /Found the bug in the form\./);
});

test('Jira Pull REQ8: an edited comment rewrites its message, a deleted one takes it out, and a reply written in the root stays', async () => {
  await ok(['comments', 'add', 'backlog:T-ACME-2', 'Agreed, shipping it.', '--reply', 't-jira-10101', '--as', 'ada']);
  const story = fake.state.issues.find((issue) => issue.key === 'ACME-2')!;
  story.fields.comments[0]!.body = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks great to me.' }] }] };
  story.fields.comments[0]!.updated = jiraNow();
  story.fields.comments.push({
    id: '30003',
    author: { accountId: '557058:lin', displayName: 'Lin Example' },
    body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One more thing.' }] }] },
    created: jiraNow(),
    updated: jiraNow(),
  });
  touch(fake.state, 'ACME-2', {}, jiraNow());
  assert.match(await ok(['jira', 'pull']), /comments 1 added, 1 changed, 0 removed/);
  let thread = readFileSync(path.join(root, '.eidos', 'plugins', 'comments', 'threads', 't-jira-10101.yaml'), 'utf8');
  assert.match(thread, /Looks great to me\./);
  assert.match(thread, /Agreed, shipping it\./);
  assert.match(thread, /One more thing\./);
  story.fields.comments.splice(0, 1);
  touch(fake.state, 'ACME-2', {}, jiraNow());
  assert.match(await ok(['jira', 'pull']), /comments 0 added, 0 changed, 1 removed/);
  thread = readFileSync(path.join(root, '.eidos', 'plugins', 'comments', 'threads', 't-jira-10101.yaml'), 'utf8');
  assert.doesNotMatch(thread, /Looks great/);
  assert.match(thread, /Agreed, shipping it\./, 'the reply written in the root stays');
});

test('Jira Pull REQ11: an issue gone from the scope leaves its task, marked gone, never deleted', async () => {
  fake.state.hidden.add('10102');
  assert.match(await ok(['jira', 'fetch']), /- ACME-3 {2}T-ACME-3 is gone from the scope/);
  assert.match(await ok(['jira', 'pull']), /1 marked gone/);
  assert.match(readFileSync(taskFile('t-acme-3-'), 'utf8'), /gone: "?\d{4}-\d{2}-\d{2}"?/);
  // back in the scope with nothing changed in Jira, it is read again and comes back
  fake.state.hidden.delete('10102');
  assert.match(await ok(['jira', 'fetch']), /↺ ACME-3 {2}T-ACME-3 is back in the scope/);
  await ok(['jira', 'pull']);
  assert.doesNotMatch(readFileSync(taskFile('t-acme-3-'), 'utf8'), /gone:/);
});

test('Jira Pull REQ14: with pull_attachments on, an attachment is downloaded into assets once and the reference points at it', async () => {
  await ok(['plugin', 'set', 'jira', 'pull_attachments', 'true']);
  touch(fake.state, 'ACME-2', {}, jiraNow());
  const fetched = await ok(['jira', 'fetch']);
  assert.match(fetched, /1 attachment to download/);
  assert.doesNotMatch(fetched, /nothing to pull/, 'a download is something to pull');
  const pulled = await ok(['jira', 'pull']);
  assert.match(pulled, /1 attachments downloaded/);
  assert.match(pulled, /1 changed/, 'a reference pointed at the file counts as a change');
  const story = readFileSync(taskFile('t-acme-2-ship'), 'utf8');
  assert.match(story, /!\[mockup\.png\]\(\.\.\/assets\/jira-20001-mockup\.png\)/, 'an image in the root is drawn as one');
  touch(fake.state, 'ACME-2', {}, jiraNow());
  assert.doesNotMatch(await ok(['jira', 'pull']), /attachments downloaded/, 'not downloaded again');
  // a comment or a description with a mention and a file reads as the pull writes it, so nothing is counted to change
  assert.match(await ok(['jira', 'fetch', '--full']), /nothing to pull/);
});

test('Jira REQ15, Jira Pull REQ10: with add_people on, a person the root does not have is listed by a fetch and added by a pull', async () => {
  await ok(['plugin', 'set', 'jira', 'add_people', 'true']);
  touch(fake.state, 'ACME-2', {}, jiraNow());
  const fetched = await ok(['jira', 'fetch', '--full']);
  assert.match(fetched, /2 people to add/);
  assert.match(fetched, /2 tasks to change/, 'a task that names them changes with them');
  assert.match(fetched, /~ ACME-2 {2}T-ACME-2: section:description/, 'its description mentions Lin');
  assert.match(fetched, /~ ACME-3 {2}T-ACME-3: assignee/, 'its assignee is Grace');
  assert.match(fetched, /@ Lin Example/);
  assert.match(fetched, /@ Grace Example/);
  assert.doesNotMatch(fetched, /@ Ada Example/, 'one the root has is not added');
  assert.doesNotMatch(await ok(['users', 'list']), /Lin Example|Grace Example/, 'a fetch adds nobody');
  assert.match(await ok(['jira', 'pull', '--full']), /2 people added/);
  assert.match(await ok(['users', 'list']), /Lin Example\s+@lin\b/);
  assert.match(readFileSync(taskFile('t-acme-2-ship'), 'utf8'), /Ask @lin about \*\*SSO\*\*\./, 'a mention reads as the user added');
  assert.doesNotMatch(await ok(['jira', 'fetch', '--full']), /people to add/, 'each is added once');
  await ok(['plugin', 'set', 'jira', 'add_people', 'false']);
});

test('Jira REQ5: a machine keeps several sign-ins to a site; a root picks one, the default is for the rest, and one is signed out alone', async () => {
  // a second account's token, as a second login keeps it
  const held = JSON.parse(readFileSync(TOKENS, 'utf8')) as { accounts: Record<string, string>; tokens: Record<string, string> };
  writeFileSync(TOKENS, JSON.stringify({ ...held, tokens: { ...held.tokens, [`${fake.url}/second@example.com`]: 'second-token' } }));
  await ok(['jira', 'use', fake.url, 'second@example.com', '--global']);
  assert.match(await ok(['jira', 'whoami']), /second@example.com, kept for this machine/, "the default, this root's own pick dropped");
  await ok(['jira', 'use', fake.url, EMAIL]);
  assert.match(await ok(['jira', 'whoami']), /tester@example.com, kept for this root/, "this root's pick before the default");
  const refused = await eidos(['jira', 'use', fake.url, 'nobody@example.com']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /no token for nobody@example.com/);
  assert.match(await ok(['jira', 'logout', fake.url, '--email', 'second@example.com']), /second@example.com/);
  const after = JSON.parse(readFileSync(TOKENS, 'utf8')) as { accounts: Record<string, string>; tokens: Record<string, string> };
  assert.deepEqual(Object.keys(after.tokens), [`${fake.url}/${EMAIL}`]);
  assert.deepEqual(after.accounts, {}, 'the default went with it');
  assert.match(await ok(['jira', 'whoami']), /tester@example.com, kept for this root/);
});

test('Jira REQ5: logout takes the sign-in and its token out', async () => {
  assert.match(await ok(['jira', 'logout', fake.url]), /Signed out/);
  assert.deepEqual(JSON.parse(readFileSync(TOKENS, 'utf8')).tokens, {});
  const refused = await eidos(['jira', 'fetch']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /nobody is signed in/);
  writeFileSync(path.join(scratch, 'done'), '');
});
