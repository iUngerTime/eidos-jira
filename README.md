# Jira for Eidos MD

Bring your team's Jira board into your Eidos root. Every issue becomes a task in the Backlog, every comment thread comes with it, and your sprints become milestones, so you can plan and work next to the blueprints while the board stays where your team keeps it.

- **See it before it lands.** A fetch shows what changed in Jira since your last pull and writes nothing. A pull brings it in.
- **Your mapping, your words.** Jira's statuses, issue types, priorities, and fields map onto your Backlog's. The plugin drafts the mapping and you accept or change each entry.
- **Comments, signed and dated.** Each issue's comments arrive as one thread on its task, signed by the people who wrote them, dated when they wrote them, with their mentions, formatting, and screenshots.
- **Safe to pull again.** Jira wins on the fields you map. A field you edited in Eidos is named before a pull overwrites it, and everything the mapping leaves alone (your notes, checklists, the blueprints a task serves, replies written in Eidos) is never touched.
- **Private by design.** It runs on your machine and talks straight to your Jira site with your own API token. There is no server in between, and nothing is sent back to Jira.

Pull only for now: changes go from Jira to Eidos. Needs Eidos MD 0.16.1 or later.

## Get started

1. **Install it.** In Eidos MD, open **Settings → Community plugins → Browse**, find **Jira**, and choose **Install**. Then switch it on under **Installed plugins**. It needs the Backlog and Comments plugins on.
2. **Sign in.** Make a classic API token at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) (**Create API token**, not the one with scopes), then in a terminal in your root:

   ```bash
   eidos jira login your-site.atlassian.net
   ```

   It asks for your Atlassian email and the token, typed hidden, and keeps the token only once Jira accepts it.

3. **Connect a board.** Use the project key and the board's number from its address (`…/projects/ACME/boards/12`):

   ```bash
   eidos jira connect acme --site your-site.atlassian.net --project ACME --board 12
   ```

4. **Map it.** `describe` reads the board, and `map` drafts the mapping and asks about each entry:

   ```bash
   eidos jira describe acme
   ```

   ```bash
   eidos jira map acme
   ```

5. **Fetch, then pull.**

   ```bash
   eidos jira fetch
   ```

   ```bash
   eidos jira pull
   ```

Signing in and connecting happen in the terminal for now; a settings page in the app is coming. `eidos instructions jira` prints the full guide, every command with its `--json` output, for you or an AI agent working in the root.

## What a pull writes

- **Tasks keyed by their issue.** `ACME-123` becomes `T-ACME-123`, so two people pulling the same board on two branches write the same file. A Jira sub-task becomes a subtask of its parent's task. The issue's link lives in the task's frontmatter under `jira`; leave that key to the plugin.
- **Comment threads.** One thread per issue, each comment signed by its author with Jira's date. Edits and deletions in Jira follow on the next pull. Comments restricted to a role or a group stay in Jira unless the connection sets `restricted_comments: true`.
- **People.** An assignee, a comment's author, or a mention is written as the root user of the same name where your root has one, and as their Jira name otherwise.
- **Sprints as milestones**, dated when the sprint ends.
- **Attachments** are links to Jira, or downloaded into `assets/` when you turn on `pull_attachments`. A downloaded image shows in place.
- **Nothing is deleted.** An issue that leaves the board keeps its task, marked as gone, and comes back if it returns.

## Settings

| Setting            | Where                | What it does                                                                                    |
| ------------------ | -------------------- | ----------------------------------------------------------------------------------------------- |
| `pull_attachments` | shared with the root | Download each issue's attachments into `assets/` instead of linking to Jira.                    |
| `add_people`       | shared with the root | Add each person a pull finds that the root doesn't have to its users.                           |
| `auto_fetch`       | yours                | Fetch every 5, 15, 30, or 60 minutes while the app has the root open. Nothing pulls on its own. |

Set one with `eidos plugin set jira <setting> <value>`.

## Your token

Your API token is kept in one file on your machine, `plugins/jira/credentials.json` in the Eidos app data folder, readable only by you. It never goes into a root, a settings file, a log, or a commit. In a script, set `JIRA_EMAIL` and `JIRA_API_TOKEN` instead. `eidos jira logout <site>` removes it.

## Develop

```bash
pnpm install
```

```bash
pnpm test
```

The build writes the release files to `dist/` (`manifest.yaml`, which carries the guide too, `cli.js`, and `instructions.md`). The tests run the real Eidos CLI against a fake Jira server (`test/fake-jira.ts`) in a scratch root, never a live Jira. To test against a CLI built from source, point `EIDOS_CLI` at its `dist/src/cli.js`. A trial against a real site belongs in `trial/`, which git ignores.

## License

[MIT](LICENSE)
