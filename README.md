# Jira for Eidos MD

A community plugin for [Eidos MD](https://eidosmd.com) that connects a root to Jira Cloud. It pulls a board's issues into the Backlog as tasks, and each issue's comments into one Comments thread, signed by the people who wrote them. You can see what a pull would do before you run it, and you choose what each Jira field becomes on a task.

It runs on your machine and talks straight to your Jira site with your own Atlassian API token. There is no server in between, and nothing goes back to Jira.

Status: pull only. Push (Eidos to Jira) is not built.

## Install

Once it is published to the Registry:

```bash
eidos plugin install @iungertime/jira
```

```bash
eidos plugin enable jira
```

```bash
eidos plugin allow jira
```

`allow` means this machine trusts the plugin's code. Until you allow it, a root that switches the plugin on loads none of it. The plugin needs the Backlog (`eidos plugin enable backlog`), and Comments for threads.

## Use

```bash
eidos jira login acme.atlassian.net
```

This asks for your Atlassian email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). The token is typed hidden and checked against Jira, and kept only once Jira accepts it. It is kept in one file on this machine, `plugins/jira/credentials.json` in the Eidos app data folder, outside every root and readable only by you, the same on macOS, Windows, and Linux. It never goes into a root or a settings file. Add `--global` to use that sign-in in every root on this machine. In a script, set `JIRA_EMAIL` and `JIRA_API_TOKEN` instead; they come first.

```bash
eidos jira connect acme --site acme.atlassian.net --project ACME --board 12
```

```bash
eidos jira describe acme
```

```bash
eidos jira map acme
```

`describe` reads the board's columns, the issue types with their statuses and fields, the priorities, the link types, and the sprints. `map` drafts a mapping from them by matching names and categories, and asks about each entry; only the ones you accept are written. To change one entry:

```bash
eidos jira configure:map acme set statuses "Code Review" "In Review"
```

Then fetch and pull, as with git:

```bash
eidos jira fetch
```

```bash
eidos jira pull
```

`fetch` shows what changed in Jira since your last pull and writes nothing. `pull` brings it in. Jira wins on every field the mapping carries. If you edited one of those fields in Eidos, the fetch names it, and `pull --keep-local` leaves your edit in place. Anything the mapping does not carry, such as your notes, checklist ticks, the blueprints a task serves, and replies written in Eidos, is never touched.

`eidos instructions jira` prints the full guide, with every command and its `--json` shape.

## What a pull writes

- Each issue becomes a task. Its id comes from the issue key (`ACME-123` becomes `T-ACME-123`), so two people pulling the same board on two branches write the same file. A Jira sub-task becomes a subtask of its parent's task, with the id the Backlog gives a subtask. The issue itself is kept in the task's frontmatter under `jira`; never edit that key.
- An issue's comments become one thread on its task, each signed by its author and dated when Jira says it was written. Edits and deletions in Jira follow. Comments restricted to a role or a group are left out unless the connection sets `restricted_comments: true`.
- People keep the names Jira gives them: an assignee, a comment's author, and a mention are written as the root user of the same name where the root has one, and as the Jira name otherwise. A pull adds nobody to the root's users unless you turn on `add_people` (`eidos plugin set jira add_people true`, shared by everyone in the root); then each person the root does not have is added as an ordinary user, named as Jira names them, which needs eidosmd 0.17.0 or later.
- A sprint becomes a milestone of the same name, dated when it ends.
- Attachments are linked to in Jira by default. Turn on `pull_attachments` (`eidos plugin set jira pull_attachments true`) to download them into `assets/` instead.
- An issue that leaves the scope keeps its task, marked `jira.gone`. Nothing is ever deleted.

## Develop

```bash
pnpm install
```

```bash
pnpm build
```

The build writes `dist/manifest.yaml`, `dist/cli.js`, and `dist/instructions.md`, the release files. `cli.js` is a CommonJS bundle whose only import from the CLI is `require('eidosmd/plugin')`, which the host answers.

The tests run the real Eidos CLI against a fake Jira server (`test/fake-jira.ts`) in a scratch root, with the credentials file in a scratch app data folder. No live Jira and no real token are used. Point `EIDOS_CLI` at a CLI's `dist/src/cli.js` that has the host features above:

```bash
EIDOS_CLI=../eidosmd/cli/dist/src/cli.js pnpm test
```

To try it by hand, start the fake server (`node --experimental-strip-types test/fake-jira.ts`), install the build into an app data folder of your own with `EIDOS_APP_DATA=/tmp/eidos-try/app pnpm install-local`, and use that same `EIDOS_APP_DATA` in a scratch root.
