// Jira Sync and Jira Push end to end: the plugin built and installed in a
// scratch root of its own, pulled from the fake Jira, then a task edited here
// and its issue edited there, and each sync and create checked against what
// the fake was sent and what the task holds after.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EMAIL, startFakeJira, TOKEN, touch } from './fake-jira.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliFile = process.env['EIDOS_CLI'] ?? path.join(repo, 'node_modules', 'eidosmd', 'dist', 'src', 'cli.js');
const version = /^version:\s*(\S+)/m.exec(readFileSync(path.join(repo, 'manifest.yaml'), 'utf8'))![1]!;

const scratch = mkdtempSync(path.join(tmpdir(), 'eidos-jira-sync-'));
const env = { ...process.env, EIDOS_APP_DATA: path.join(scratch, 'app'), EIDOS_NO_TELEMETRY: '1', JIRA_EMAIL: '', JIRA_API_TOKEN: '', EIDOS_USER: 'tester' };
const root = path.join(scratch, 'Blueprints');
let fake: Awaited<ReturnType<typeof startFakeJira>>;

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

let tick = 0;
const jiraNow = (): string => new Date(Date.now() + 60_000 + (tick += 1) * 1000).toISOString().replace('Z', '+0000');
// a task's file by the id its frontmatter holds, since a subtask's file name begins as its parent's does
const taskFile = (id: string): string => {
  const dir = path.join(root, 'backlog');
  const name = readdirSync(dir).find((file) => file.endsWith('.md') && readFileSync(path.join(dir, file), 'utf8').startsWith(`---\nid: ${id}\n`));
  assert.ok(name, `no file holds ${id}`);
  return path.join(dir, name);
};
// one target's threads as `eidos comments <target> --json` prints them
type Thread = { id: string; messages: Array<{ author: string; text: string; external?: string }> };
const threadsOf = (printed: string): Thread[] => {
  const value = JSON.parse(printed) as Thread[] | { threads: Thread[] } | Array<{ threads: Thread[] }>;
  if (Array.isArray(value)) return value.flatMap((entry) => ('threads' in entry ? entry.threads : [entry as Thread]));
  return value.threads;
};
const issue = (key: string) => fake.state.issues.find((held) => held.key === key)!;
const writesSince = (count: number) => fake.state.writes.slice(count);

before(async () => {
  fake = await startFakeJira();
  const dir = path.join(scratch, 'app', 'plugins', 'jira', version);
  mkdirSync(dir, { recursive: true });
  for (const file of ['manifest.yaml', 'cli.js']) copyFileSync(path.join(repo, 'dist', file), path.join(dir, file));
  const cliVersion = /eidosmd (\S+)/.exec(await ok(['--version']))?.[1] ?? '';
  const manifest = path.join(dir, 'manifest.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^min_host: .*$/m, `min_host: ${cliVersion}`));
  await ok(['install', '--blank', root, '--product', 'Scratch', '--yes', '--offline']);
  await ok(['plugin', 'enable', 'backlog']);
  await ok(['plugin', 'enable', 'jira']);
  await ok(['plugin', 'allow', 'jira']);
  await ok(['users', 'add', 'Tester', '--alias', 'tester', '--email', EMAIL]);
  await ok(['users', 'add', 'Ada Example', '--alias', 'ada']);
  await ok(['jira', 'login', fake.url], `${EMAIL}\n${TOKEN}\n`);
  await ok(['jira', 'connect', 'acme', '--site', fake.url, '--project', 'ACME', '--board', '1']);
  await ok(['jira', 'describe', 'acme']);
  await ok(['jira', 'pull', 'acme']);
});

after(async () => {
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
});

test('Jira Pull REQ5: a pull keeps Jira’s own value of each field beside the digest, and priorities a mapping leaves out go by their rank', async () => {
  const text = readFileSync(taskFile('T-ACME-3'), 'utf8');
  assert.match(text, /\n {2}remote:\n/);
  // Low is fourth of Highest, High, Medium, Low; the Backlog's lowest takes it
  assert.match(text, /\npriority: low\n/);
});

test('Jira Sync REQ2, REQ3: a task edited here and an issue untouched there is a sync to Jira; status goes through the one transition', async () => {
  await ok(['backlog', 'set', 'T-ACME-3', '--status', 'In Progress', '--title', 'Login button is misaligned on mobile']);
  assert.match(await ok(['jira', 'status']), /~ ACME-3 {2}T-ACME-3: (status, title|title, status)/);
  const before = fake.state.writes.length;
  const plan = await ok(['jira', 'sync', 'T-ACME-3', '--dry-run']);
  assert.match(plan, /→ title +to Jira: Login button is misaligned on mobile/);
  assert.match(plan, /→ status: To Do → In Progress/);
  assert.equal(fake.state.writes.length, before, 'a dry run sends nothing');
  const unconfirmed = await ok(['jira', 'sync', 'T-ACME-3']);
  assert.match(unconfirmed, /nothing written: run in a terminal to confirm, or pass --yes/);
  assert.match(await ok(['jira', 'sync', 'T-ACME-3', '--yes']), /synced ACME-3: sent title, status/);
  assert.equal(issue('ACME-3').fields['summary'], 'Login button is misaligned on mobile');
  assert.equal((issue('ACME-3').fields['status'] as { name: string }).name, 'In Progress');
  const sent = writesSince(before);
  assert.deepEqual(
    sent.map((write) => `${write.method} ${write.path}`),
    ['PUT /rest/api/3/issue/10102', 'POST /rest/api/3/issue/10102/transitions'],
  );
  assert.deepEqual(Object.keys(sent[0]!.body['fields'] as object), ['summary'], 'only what changed here is sent');
  assert.match(await ok(['jira', 'sync', 'T-ACME-3', '--dry-run']), /level: nothing to sync/);
  assert.match(await ok(['jira', 'status', 'acme']), /nothing edited here/);
});

test('Jira Sync REQ2: a field Jira changed and the task did not comes in, written as a pull writes it', async () => {
  touch(fake.state, 'ACME-3', { summary: 'Login button misaligned (iOS)' }, jiraNow());
  const plan = await ok(['jira', 'sync', 'T-ACME-3', '--yes']);
  assert.match(plan, /← title +from Jira: Login button misaligned \(iOS\)/);
  assert.match(readFileSync(taskFile('T-ACME-3'), 'utf8'), /\ntitle: Login button misaligned \(iOS\)\n/);
});

test('Jira Sync REQ2, REQ4: Jira moving between two statuses that read as one is still a change there; with the task moved too, it is a conflict settled with --take', async () => {
  // ACME-2 is in Code Review, which reads as In Progress here; Jira moves it on to In Progress, the person to Done
  touch(fake.state, 'ACME-2', { status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } } }, jiraNow());
  await ok(['backlog', 'set', 'T-ACME-2', '--status', 'Done']);
  const before = fake.state.writes.length;
  const blocked = await eidos(['jira', 'sync', 'T-ACME-2', '--yes']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /! status +here Done \| Jira In Progress/);
  assert.match(blocked.stdout, /status: changed in both places/);
  assert.equal(fake.state.writes.length, before, 'nothing of a blocked issue is sent');
  // taken as the task has it: Done is behind a screen that asks for a resolution
  const screen = await eidos(['jira', 'sync', 'T-ACME-2', '--take', 'status=eidos', '--yes']);
  assert.equal(screen.status, 1);
  assert.match(screen.stdout, /the transition to Done asks for Resolution/);
  assert.match(screen.stdout, /--field resolution="<Done \| Won't Do>"/);
  assert.match(await ok(['jira', 'sync', 'T-ACME-2', '--take', 'status=eidos', '--field', 'resolution=Done', '--yes']), /synced ACME-2: sent status/);
  assert.equal((issue('ACME-2').fields['status'] as { name: string }).name, 'Done');
  assert.deepEqual((writesSince(before).at(-1)!.body['fields'] as { resolution: unknown }).resolution, { id: '1' });
});

test('Jira Sync REQ7: a status more than one transition away is named with where Jira can go, and --via walks there', async () => {
  // Done leaves only to To Do; In Progress is two away
  await ok(['backlog', 'set', 'T-ACME-2', '--status', 'In Progress']);
  const blocked = await eidos(['jira', 'sync', 'T-ACME-2', '--yes']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /Done has no transition to In Progress\n/);
  assert.match(blocked.stdout, /from Done Jira goes to To Do/);
  assert.match(await ok(['jira', 'sync', 'T-ACME-2', '--via', 'To Do', '--status-to', 'In Progress', '--yes']), /sent status/);
  assert.equal((issue('ACME-2').fields['status'] as { name: string }).name, 'In Progress');
});

test('Jira Sync REQ9: a description edited here goes back with the mention and the file Jira held, untouched where the person did not edit', async () => {
  const file = taskFile('T-ACME-2');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /- email and password/);
  writeFileSync(file, text.replace('- email and password', '- email, password, and a passkey'));
  const before = fake.state.writes.length;
  const out = await ok(['jira', 'sync', 'T-ACME-2', '--yes']);
  assert.match(out, /sent section:description/);
  const description = (writesSince(before)[0]!.body['fields'] as { description: { content: Array<{ type: string; content?: Array<{ type: string }> }> } }).description;
  const kinds = description.content.map((node) => node.type);
  assert.deepEqual(kinds, ['heading', 'paragraph', 'bulletList', 'codeBlock', 'mediaSingle']);
  assert.ok(
    description.content[1]!.content!.some((node) => node.type === 'mention'),
    "the paragraph with the mention went back as Jira's own",
  );
  assert.doesNotMatch(out, /drops from Jira/);
});

test('Jira Sync REQ9: rewriting the text around a file Jira holds is refused until the loss is agreed to', async () => {
  const file = taskFile('T-ACME-2');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /\[mockup\.png\]\(/);
  writeFileSync(file, text.replace(/!?\[mockup\.png\]\([^)]*\)/, 'the mockup is in Figma now'));
  const blocked = await eidos(['jira', 'sync', 'T-ACME-2', '--yes']);
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /takes out of Jira what markdown cannot hold: 1 media, 1 mediaSingle/);
  assert.match(await ok(['jira', 'sync', 'T-ACME-2', '--accept-loss', 'section:description', '--yes']), /sent section:description/);
});

test('Jira Sync REQ11: only your own new message in the issue’s thread is sent, and once sent it is the pulled comment, never added twice', async () => {
  const listed = await ok(['comments', 'backlog:T-ACME-2', '--json']);
  const thread = threadsOf(listed).find((held) => held.id === 't-jira-10101')!;
  assert.ok(thread, 'the pull made the issue’s thread');
  await ok(['comments', 'add', 'backlog:T-ACME-2', '--reply', thread.id, 'Passkeys are in scope for this one.']);
  const before = fake.state.writes.length;
  const plan = await ok(['jira', 'sync', 'T-ACME-2', '--dry-run']);
  assert.match(plan, /→ comment: Passkeys are in scope for this one\./);
  assert.match(await ok(['jira', 'sync', 'T-ACME-2', '--yes']), /1 comment sent/);
  assert.equal(writesSince(before).filter((write) => write.path.endsWith('/comment')).length, 1);
  await ok(['jira', 'pull', 'acme']);
  const messages = threadsOf(await ok(['comments', 'backlog:T-ACME-2', '--json']))
    .find((held) => held.id === 't-jira-10101')!
    .messages.filter((message) => message.text.includes('Passkeys'));
  assert.equal(messages.length, 1, 'the pull reads the sent comment as the one it is');
  assert.match(await ok(['jira', 'sync', 'T-ACME-2', '--dry-run']), /level: nothing to sync/);
});

test('Jira Push REQ3, REQ5: a create is planned first; a Backlog type several Jira types read as is settled with --type', async () => {
  await ok(['backlog', 'add', 'Add a passkey sign-in', '--body', 'description=Let people **sign in** with a passkey.']);
  const task = (JSON.parse(await ok(['backlog', '--json'])) as { tasks: Array<{ id: string; title: string }> }).tasks.find((held) => held.title === 'Add a passkey sign-in')!;
  const ambiguous = await eidos(['jira', 'create', task.id, '--connection', 'acme', '--yes']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stdout, /default is Epic or Story or Bug in Jira/);
  assert.match(ambiguous.stdout, /set create.types default "<Jira type>"/);
  assert.match(ambiguous.stdout, /Nothing created/);
  // the page settles the same blocker from the choices it carries
  const asked = JSON.parse((await eidos(['jira', 'create', task.id, '--connection', 'acme', '--json'])).stdout) as { plans: Array<{ blockers: Array<{ ask?: { kind: string; choices: string[] } }> }> };
  assert.deepEqual(asked.plans[0]!.blockers[0]!.ask, { kind: 'type', choices: ['Epic', 'Story', 'Bug'] });
  const plan = await ok(['jira', 'create', task.id, '--connection', 'acme', '--type', 'Story']);
  assert.match(plan, /a new Story in ACME/);
  assert.match(plan, /summary +Add a passkey sign-in/);
  assert.match(plan, /Nothing created: run in a terminal to confirm, or pass --yes/);
  const made = await ok(['jira', 'create', task.id, '--connection', 'acme', '--type', 'Story', '--yes']);
  const key = /→ (ACME-\d+)/.exec(made)![1]!;
  assert.equal(issue(key).fields['summary'], 'Add a passkey sign-in');
  assert.equal((fake.state.properties.get(`${issue(key).id}/eidos`) as { task: string }).task, task.id);
  const text = readFileSync(taskFile(task.id), 'utf8');
  assert.match(text, new RegExp(`\\n {2}key: ${key}\\n`));
  assert.match(text, /\n {2}connection: acme\n/);
  assert.doesNotMatch(text, /pending/);
  // the issue starts in the workflow's first status; the task's own is the next sync's to send
  await ok(['backlog', 'set', task.id, '--status', 'In Progress']);
  assert.match(await ok(['jira', 'sync', task.id, '--yes']), /sent status/);
  assert.equal((issue(key).fields['status'] as { name: string }).name, 'In Progress');
  const again = await eidos(['jira', 'create', task.id, '--connection', 'acme', '--yes']);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, new RegExp(`already holds ${key}`));
});

test('Jira Push REQ13: a create cut short after Jira made the issue is found by its mark, never made twice', async () => {
  await ok(['backlog', 'add', 'Remember the last sign-in method']);
  const task = (JSON.parse(await ok(['backlog', '--json'])) as { tasks: Array<{ id: string; title: string }> }).tasks.find((held) => held.title === 'Remember the last sign-in method')!;
  fake.state.failCreateAfterWrite = true;
  const count = fake.state.issues.length;
  const cut = await eidos(['jira', 'create', task.id, '--connection', 'acme', '--type', 'Story', '--yes']);
  assert.notEqual(cut.status, 0);
  assert.equal(fake.state.issues.length, count + 1, 'Jira made the issue before the answer was lost');
  assert.match(readFileSync(taskFile(task.id), 'utf8'), /\n {2}pending: /);
  assert.match(await ok(['jira', 'status', 'acme']), new RegExp(`${task.id}: a create was cut short`));
  const found = await ok(['jira', 'create', task.id, '--connection', 'acme', '--yes']);
  assert.match(found, /found by its mark/);
  assert.equal(fake.state.issues.length, count + 1, 'no second issue');
  assert.doesNotMatch(readFileSync(taskFile(task.id), 'utf8'), /pending/);
});

test('Jira Sync REQ2: a field the root owns is never pulled over; Jira changing it is a conflict to settle', async () => {
  await ok(['jira', 'configure:map', 'acme', 'set', 'fields', 'summary', 'title', '--owner', 'eidos']);
  await ok(['jira', 'configure:map', 'acme', 'set', 'fields', 'status', 'status']);
  touch(fake.state, 'ACME-3', { summary: 'Renamed in Jira' }, jiraNow());
  const pulled = await ok(['jira', 'pull', 'acme']);
  assert.match(pulled, /acme: /);
  assert.doesNotMatch(readFileSync(taskFile('T-ACME-3'), 'utf8'), /Renamed in Jira/);
  const blocked = await eidos(['jira', 'sync', 'T-ACME-3', '--yes']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /Jira changed title, a field the root owns/);
  assert.match(await ok(['jira', 'sync', 'T-ACME-3', '--take', 'title=eidos', '--yes']), /sent title/);
  assert.equal(issue('ACME-3').fields['summary'], 'Login button misaligned (iOS)');
});

test('Jira Sync REQ6: a message Jira took whose answer was lost is taken in by the next pull as that comment, not added twice', async () => {
  await ok(['comments', 'add', 'backlog:T-ACME-2', '--reply', 't-jira-10101', 'Checked on an iPhone SE too.']);
  // as a sync cut short leaves it: Jira holds the comment, the thread holds the message unsent
  const held = issue('ACME-2');
  const at = jiraNow();
  held.fields.comments.push({
    id: '39999',
    author: { accountId: '557058:tester', displayName: 'Tester', emailAddress: EMAIL },
    body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Checked on an iPhone SE too.' }] }] },
    created: at,
    updated: at,
  });
  held.fields.updated = at;
  await ok(['jira', 'pull', 'acme']);
  const messages = threadsOf(await ok(['comments', 'backlog:T-ACME-2', '--json']))
    .flatMap((held) => held.messages)
    .filter((message) => message.text === 'Checked on an iPhone SE too.');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.external, 'jira:39999');
});

test('Jira Sync REQ11: jira comment sends a comment to an issue with no thread yet, and the thread it starts is the pulled one', async () => {
  const before = issue('ACME-3').fields.comments.length;
  assert.match(await ok(['jira', 'comment', 'T-ACME-3', 'Fixed', 'on', 'the', 'SE', 'as', 'well.']), /Comment sent to ACME-3/);
  assert.equal(issue('ACME-3').fields.comments.length, before + 1);
  const thread = threadsOf(await ok(['comments', 'backlog:T-ACME-3', '--json'])).find((held) => held.id === 't-jira-10102')!;
  assert.equal(thread.messages.at(-1)!.text, 'Fixed on the SE as well.');
  assert.match(thread.messages.at(-1)!.external ?? '', /^jira:/);
  await ok(['jira', 'pull', 'acme']);
  assert.equal(
    threadsOf(await ok(['comments', 'backlog:T-ACME-3', '--json']))
      .flatMap((held) => held.messages)
      .filter((message) => message.text === 'Fixed on the SE as well.').length,
    1,
  );
});

test('Jira Sync REQ6: a sync leaves the next pull to read the issue, so a colleague’s comment made alongside it still comes in', async () => {
  const held = issue('ACME-3');
  const at = jiraNow();
  held.fields.comments.push({
    id: '39998',
    author: { accountId: '557058:grace', displayName: 'Grace Example' },
    body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Seen on Android too.' }] }] },
    created: at,
    updated: at,
  });
  held.fields.updated = at;
  await ok(['backlog', 'set', 'T-ACME-3', '--title', 'Login button misaligned (iOS, Android)']);
  assert.match(await ok(['jira', 'sync', 'T-ACME-3', '--take', 'title=eidos', '--yes']), /sent title/);
  const pulled = await ok(['jira', 'pull', 'acme']);
  const texts = threadsOf(await ok(['comments', 'backlog:T-ACME-3', '--json'])).flatMap((thread) => thread.messages.map((message) => message.text));
  assert.ok(texts.includes('Seen on Android too.'), `${pulled}\n${texts.join(' | ')}\n${readFileSync(taskFile('T-ACME-3'), 'utf8').slice(0, 900)}`);
});

test('Jira Sync REQ16: a subtask under its pulled parent is level, its parent read by the issue it holds', async () => {
  assert.match(await ok(['jira', 'sync', 'T-ACME-2.1', '--dry-run']), /level: nothing to sync/);
});

test("Jira Sync: a task marked Don't sync is the root's own, never pulled over, synced, created, or listed as edited", async () => {
  await ok(['backlog', 'set', 'T-ACME-3', '--title', 'Kept in Eidos only']);
  assert.match(await ok(['jira', 'skip', 'T-ACME-3']), /marked Don't sync/);
  assert.doesNotMatch(await ok(['jira', 'status', 'acme']), /T-ACME-3/);
  touch(fake.state, 'ACME-3', { summary: 'Renamed in Jira again' }, jiraNow());
  assert.match(await ok(['jira', 'pull', 'acme', '--dry-run']), /ACME-3 {2}T-ACME-3 is marked Don't sync; the pull leaves it/);
  await ok(['jira', 'pull', 'acme']);
  assert.match(readFileSync(taskFile('T-ACME-3'), 'utf8'), /title: Kept in Eidos only/);
  const refused = await eidos(['jira', 'sync', 'T-ACME-3', '--dry-run']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /is marked Don't sync/);
  await ok(['backlog', 'add', 'Internal chore']);
  const chore = (JSON.parse(await ok(['backlog', '--json'])) as { tasks: Array<{ id: string; title: string }> }).tasks.find((held) => held.title === 'Internal chore')!;
  await ok(['jira', 'skip', chore.id]);
  const create = await eidos(['jira', 'create', chore.id, '--connection', 'acme', '--type', 'Story', '--yes']);
  assert.notEqual(create.status, 0);
  assert.match(create.stderr, /is marked Don't sync/);
  // clearing the mark hands the task back, the issue key it holds untouched
  assert.match(await ok(['jira', 'skip', 'T-ACME-3', '--off']), /syncs with Jira again/);
  assert.match(readFileSync(taskFile('T-ACME-3'), 'utf8'), /\n {2}key: ACME-3\n/);
  assert.doesNotMatch(readFileSync(taskFile('T-ACME-3'), 'utf8'), /skip:/);
});

test('Jira REQ21, Jira Sync REQ17: sections bundled into the description go as one text under their headings, come back split, and a section Jira has no heading for is left alone', async () => {
  // an earlier test left the connection carrying the title and status alone; the description goes back to its section first
  await ok(['jira', 'configure:map', 'acme', 'set', 'fields', 'description', 'section:description']);
  const mapped = await ok(['jira', 'configure:map', 'acme', 'set', 'fields', 'description', 'section:acceptance-criteria', '--also']);
  assert.match(mapped, /acme: fields description → section:acceptance-criteria/);
  // the title an earlier test left changed on both sides is settled first, so only the sections move
  await ok(['jira', 'sync', 'T-ACME-3', '--take', 'title=jira', '--yes']);
  await ok([
    'backlog',
    'set',
    'T-ACME-3',
    '--body',
    'description=Misaligned on small screens.',
    '--add-line',
    'acceptance-criteria=Aligned on iOS',
    '--add-line',
    'acceptance-criteria=Aligned on Android',
  ]);
  await ok(['backlog', 'check', 'T-ACME-3', '1']);
  const plan = (await eidos(['jira', 'sync', 'T-ACME-3', '--dry-run'])).stdout;
  // the description's Jira side was never recorded (its pair was just mapped again), so it is put to the person; the
  // criteria, which Jira's text has no heading for, are simply sent
  assert.match(plan, /! section:description/);
  assert.match(plan, /→ section:acceptance-criteria/);
  assert.doesNotMatch(plan, /! section:acceptance-criteria/, 'a section Jira has no heading for is no conflict');
  assert.match(await ok(['jira', 'sync', 'T-ACME-3', '--take', 'section:description=eidos', '--yes']), /synced ACME-3: sent section:description, section:acceptance-criteria/);
  type Block = { type: string; attrs?: Record<string, unknown>; content?: Block[]; text?: string };
  const held = issue('ACME-3').fields['description'] as { content: Block[] };
  const words = (node: Block): string => (node.text ?? '') + (node.content ?? []).map(words).join('');
  assert.deepEqual(
    held.content.map((block) => block.type),
    ['paragraph', 'heading', 'taskList'],
    'the description, then the criteria under their heading as a task list',
  );
  assert.equal(words(held.content[1]!), 'Acceptance Criteria');
  assert.deepEqual(
    held.content[2]!.content!.map((item) => [item.attrs?.['state'], words(item)]),
    [
      ['DONE', 'Aligned on iOS'],
      ['TODO', 'Aligned on Android'],
    ],
  );
  assert.match(await ok(['jira', 'sync', 'T-ACME-3', '--dry-run']), /level: nothing to sync/);

  // a criterion changed in Jira comes back to its section, numbered, and the description is left as it is
  const changed = JSON.parse(JSON.stringify(held)) as { content: Block[] };
  const second = changed.content[2]!.content![1]!;
  second.attrs = { ...second.attrs, state: 'DONE' };
  second.content = [{ type: 'text', text: 'Aligned on Android 14' }];
  touch(fake.state, 'ACME-3', { description: changed }, jiraNow());
  await ok(['jira', 'pull', 'acme']);
  const text = readFileSync(taskFile('T-ACME-3'), 'utf8');
  assert.match(text, /- \[x\] #1 Aligned on iOS\n- \[x\] #2 Aligned on Android 14/);
  assert.match(text, /Misaligned on small screens\./);
  assert.match(await ok(['jira', 'sync', 'T-ACME-3', '--dry-run']), /level: nothing to sync/);

  // ACME-2's description has no criteria heading: a pull leaves its criteria as the root has them, and a sync sends them
  await ok(['backlog', 'set', 'T-ACME-2', '--add-line', 'acceptance-criteria=Works offline']);
  await ok(['jira', 'pull', 'acme', '--full']);
  assert.match(readFileSync(taskFile('T-ACME-2'), 'utf8'), /- \[ \] #1 Works offline/);
  const toSend = await ok(['jira', 'sync', 'T-ACME-2', '--dry-run']);
  assert.match(toSend, /→ section:acceptance-criteria/);
  assert.doesNotMatch(toSend, /! section:acceptance-criteria/);

  const unmapped = await ok(['jira', 'configure:map', 'acme', 'unset', 'fields', 'description', 'section:acceptance-criteria', '--also']);
  assert.match(unmapped, /acme: fields description unset/);
  const settings = readFileSync(path.join(root, '.eidos', 'plugins', 'jira', 'settings.yaml'), 'utf8');
  assert.doesNotMatch(settings, /acceptance-criteria/);
  assert.match(settings, /jira: description\n\s+eidos: section:description/, 'the description keeps its own section');
});

test('Jira Sync REQ18: a section changed in Jira and here is merged with --take both, the merged text going to the task and to Jira alike', async () => {
  await ok(['jira', 'configure:map', 'acme', 'set', 'fields', 'description', 'section:acceptance-criteria', '--also']);
  await ok(['backlog', 'set', 'T-ACME-3', '--add-line', 'acceptance-criteria=Aligned on tablets']);
  type Block = { type: string; attrs?: Record<string, unknown>; content?: Block[]; text?: string };
  const held = JSON.parse(JSON.stringify(issue('ACME-3').fields['description'])) as { content: Block[] };
  const list = held.content.find((block) => block.type === 'taskList')!;
  list.content!.push({ type: 'taskItem', attrs: { localId: 'x9', state: 'TODO' }, content: [{ type: 'text', text: 'Aligned on desktop' }] });
  touch(fake.state, 'ACME-3', { description: held }, jiraNow());
  const blocked = await eidos(['jira', 'sync', 'T-ACME-3', '--dry-run']);
  assert.match(blocked.stdout, /! section:acceptance-criteria/);
  const merged = await ok(['jira', 'sync', 'T-ACME-3', '--take', 'section:acceptance-criteria=both', '--yes']);
  assert.match(merged, /synced ACME-3/);
  assert.match(readFileSync(taskFile('T-ACME-3'), 'utf8'), /- \[x\] #1 Aligned on iOS\n- \[x\] #2 Aligned on Android 14\n- \[ \] #3 Aligned on desktop\n- \[ \] #4 Aligned on tablets/);
  const words = (node: Block): string => (node.text ?? '') + (node.content ?? []).map(words).join('');
  const after = (issue('ACME-3').fields['description'] as { content: Block[] }).content.find((block) => block.type === 'taskList')!;
  assert.deepEqual(after.content!.map(words), ['Aligned on iOS', 'Aligned on Android 14', 'Aligned on desktop', 'Aligned on tablets']);
  assert.match(await ok(['jira', 'sync', 'T-ACME-3', '--dry-run']), /level: nothing to sync/);
  const refused = await eidos(['jira', 'sync', 'T-ACME-3', '--take', 'title=both', '--dry-run']);
  assert.match(refused.stderr, /--take title=both merges a section/);
});
