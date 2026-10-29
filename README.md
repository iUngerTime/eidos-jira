# Jira Sync for Eidos MD

Bring your team's Jira board into your Eidos root, and send your work back. Every issue becomes a task in the Backlog, every comment thread comes with it, and your sprints become milestones, so you plan and work next to the blueprints while the board stays where your team keeps it.

- **See it before it lands.** A fetch shows what changed in Jira since your last pull and writes nothing. A pull brings it in.
- **Your mapping, your words.** Jira's statuses, issue types, priorities, and fields map onto your Backlog's, on a mapping page of their own. The plugin drafts the mapping and you change any entry.
- **Comments, signed and dated.** Each issue's comments arrive as one thread on its task, signed by the people who wrote them, with their mentions, formatting, and screenshots.
- **Send your changes back, one ticket at a time.** A sync brings a task and its issue level field by field: what changed in Jira comes in, what you changed goes out, and anything changed on both sides waits for you. You see the whole plan first, both sides of a text in full, and nothing is written over unseen.
- **Merge like git.** A section changed in Jira and in Eidos is settled conflict by conflict: keep Jira's lines, yours, or both, and edit the result before it goes.
- **Acceptance criteria in the description.** Bundle several sections into one Jira field: the description first, then each other section under its own heading, a checklist as Jira checkboxes, split back apart on a pull.
- **Make a ticket from a task**, with the issue type and anything Jira requires chosen in the page.
- **Keep some work in Eidos.** Mark a task **Don't sync** and Jira and the task leave each other alone.
- **Sync on its own, when you trust it.** Off until you turn it on: after each save, after each push, or both. Anything to settle waits under **Needs you**.
- **Private by design.** It runs on your machine and talks straight to your Jira site with your own API token. There is no server in between.

Works from the terminal with Eidos MD 0.16.1 or later. Its pages in the app (the settings page, the Jira Sync sidebar, the panel beside an open task, the mapping page, the sync review) need the next Eidos MD release, the first to load a community plugin's page.

## Get started

1. **Install it.** In Eidos MD, open **Settings → Community plugins → Browse**, find **Jira Sync**, and choose **Install**. Then switch it on under **Installed plugins**. It needs the Backlog and Comments plugins on.
2. **Sign in.** Make a classic API token at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) (**Create API token**, not the one with scopes). Then sign in on the plugin's settings page (**Settings → Community plugins → Jira Sync**), or in a terminal in your root:

   ```bash
   eidos jira login your-site.atlassian.net
   ```

   The token is kept only once Jira accepts it.

3. **Connect a board.** Paste the board's address (`…/projects/ACME/boards/12`) under **Boards** on the settings page, or:

   ```bash
   eidos jira connect acme --site your-site.atlassian.net --key ACME --board 12
   ```

4. **Map it.** **Edit mapping** opens the board's mapping page: each Jira status, issue type, priority, and link type with the Backlog value it maps to, and each issue type's fields with where they land. From the terminal, `eidos jira describe acme` then `eidos jira map acme`.
5. **Fetch, then pull**, from the Jira Sync sidebar in the Activity Bar, or `eidos jira fetch` and `eidos jira pull`.

`eidos instructions jira` prints the full guide, every command with its `--json` output, for you or an AI agent working in the root.

## Work a ticket

Open a task the Backlog shows and its Jira panel sits beside it, in the auxiliary sidebar: whether it is in Jira, what a sync would carry each way, read again a moment after you edit, and **Sync with Jira…**, **Open in Jira**, or **Create in Jira…** for a task not in Jira yet. The Jira Sync sidebar lists the tasks edited since their last pull or sync, and the ones waiting for you.

The sync review shows each field that moves: `←` from Jira, `→` to Jira, `!` changed on both sides. A text shows Jira's version and yours line by line, the lines only one side holds marked. A conflict offers **Keep Jira's**, **Keep mine**, or, for a section, **Merge…**.

From the terminal:

```bash
eidos jira status
eidos jira sync T-ACME-123 --dry-run
```

then the same without `--dry-run` to confirm (or `--yes` from a script).

- **Conflicts are yours to settle.** A field changed in both places stops that ticket until you pick a side (`--take status=eidos`), or a section is merged (`--take section:acceptance-criteria=both`, every conflict kept from both sides).
- **Statuses go through your workflow.** A sync uses Jira's transitions, asks for what a transition screen needs, and never picks between statuses your mapping folds together without you (`--status-to`, `--via`, `--field resolution=Done`).
- **Rich text survives.** A description goes back with every paragraph you did not touch exactly as Jira holds it, panels, mentions, and screenshots included. A rewrite that would drop one says so and waits for you (`--accept-loss`).
- **Only your comments.** New replies you write in the issue's thread are sent as your account; nobody else's are. `eidos jira comment T-ACME-123 "…"` comments on a ticket with no thread yet.
- **Owned fields.** Mark a field as Eidos's (`--owner eidos` on its pair) and a pull never overwrites it; a change made to it in Jira becomes a conflict at the next sync.
- **Don't sync.** The switch on the task's panel, or `eidos jira skip T-ACME-123` (`--off` to undo): no pull writes the task and nothing of it goes to Jira.

To make a ticket from a task, **Create in Jira…** on its panel, or:

```bash
eidos jira create T-12 --connection acme --type Story
```

It shows the plan first and makes nothing while something stops it. A create cut short is found again by a mark on the issue, never made twice.

## Several sections in one field

On the mapping page, under **Fields**, a rich-text field mapped to a section (the description) has **Add a section**: add Acceptance Criteria and Jira holds both as one text, the description, then `## Acceptance Criteria` with each criterion a checkbox. From the terminal:

```bash
eidos jira configure:map acme set fields description section:acceptance-criteria --also
```

A pull splits Jira's text at those headings, each part back to its section; a section Jira's text has no heading for (an issue written in Jira) is left as you have it, and the next sync sends it. Each section syncs on its own, so an edit to the criteria here and to the description in Jira is no conflict. A section mapped nowhere (Implementation Plan, Implementation Notes) never goes to Jira.

## Auto sync

Each person's, off by default, on the settings page under **Options**:

- **Sync a task after it is saved**: a task edited here goes to Jira a few seconds after its last save.
- **Sync after a push**: every task edited here goes to Jira once the app pushes.

Both run only while the app has the root open, only for tasks edited here, never for one marked Don't sync. A sync that finds anything to settle writes nothing: the task goes under **Needs you** in the Jira Sync sidebar with what stops it, a notification says so once, and **Review** settles it.

## What a pull writes

- **Tasks keyed by their issue.** `ACME-123` becomes `T-ACME-123`, so two people pulling the same board on two branches write the same file. A Jira sub-task becomes a subtask of its parent's task. The issue's link lives in the task's frontmatter under `jira`; leave that key to the plugin.
- **Comment threads.** One thread per issue, each comment signed by its author with Jira's date. Edits and deletions in Jira follow on the next pull. Comments restricted to a role or a group stay in Jira unless the connection sets `restricted_comments: true`.
- **People.** An assignee, a comment's author, or a mention is written as the root user of the same name where your root has one, and as their Jira name otherwise.
- **Sprints as milestones**, dated when the sprint ends.
- **Attachments** are links to Jira, or downloaded through the Assets plugin when you turn on **Download attachments**, into its first asset folder or the one you pick under **Attachments folder** (a folder of their own, if the root declares one). A downloaded image shows in place.
- **Nothing is deleted.** An issue that leaves the board keeps its task, marked as gone, and comes back if it returns.

## Settings

| Setting             | Where                | What it does                                                                                    |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `pull_attachments`  | shared with the root | Download each issue's attachments through the Assets plugin instead of linking to Jira.         |
| `attachments_folder` | shared with the root | The asset folder downloads go to; empty, the Assets plugin's first folder.                     |
| `add_people`        | shared with the root | Add each person a pull finds that the root doesn't have to its users.                           |
| `auto_fetch`        | yours                | Fetch every 5, 15, 30, or 60 minutes while the app has the root open. Nothing pulls on its own. |
| `auto_sync_on_save` | yours                | Sync a task edited here a few seconds after its last save.                                      |
| `auto_sync_on_push` | yours                | Sync every task edited here once the app pushes.                                                |

Set one on the settings page, or with `eidos plugin set jira <setting> <value>`.

## Your sign-ins

Your API token is kept in one file on your machine, `plugins/jira/credentials.json` in the Eidos app data folder, readable only by you. It never goes into a root, a settings file, a log, or a commit. In a script, set `JIRA_EMAIL` and `JIRA_API_TOKEN` instead.

It may keep several accounts for a site. Each root uses its own pick or, without one, the default: on the settings page, **Use here** and **Make default** on each account, or `eidos jira use <site> <email> [--global]`. `eidos jira logout <site> --email <email>` signs one account out; without `--email`, all of them.

## Develop

```bash
pnpm install
pnpm test
```

The build writes the release files to `dist/`: `manifest.yaml` (which carries the guide too), `cli.js`, `app.js`, `page.js`, and `instructions.md`. The tests run the real Eidos CLI against a fake Jira server (`test/fake-jira.ts`) in a scratch root, never a live Jira; point `EIDOS_CLI` at a CLI built from source to test against it. To try a build in the app, link `dist/` under **Settings → Community plugins → Develop → Link a folder…** (with **Enable developer settings** on), or `eidos plugin link dist`, and the app reloads it as the build rewrites it. A trial against a real site belongs in `trial/`, which git ignores.

## License

[MIT](LICENSE)
