## Jira

Jira is a plugin from outside the package (`@iungertime/jira`) that connects a root to Jira Cloud boards. Each connection is one board or project with one direction; pull brings Jira's issues into the Backlog as tasks, and their comments as Comments threads. A person is written as the root user of the same name where the root has one, else as Jira names them. With `add_people` on (a root setting, off by default) a pull adds each person the root does not have to its users, and a fetch lists them (`@` lines). Push is not built yet. The root of blueprints stays the source of truth for everything the mapping leaves alone; Jira wins on every field the mapping carries, and nothing is sent back to Jira.

### Files

- `.eidos/plugins/jira/settings.yaml`: `connections` (shared), each `{ name, site, project, board?, jql?, direction, restricted_comments?, mapping }`, and `pull_attachments`.
- `.eidos/plugins/jira/local.yaml`: `accounts`, the email each site signs in with for this root; `auto_fetch`. Never committed.
- `.eidos/plugins/jira/local/`: what `describe` read per connection, and the last pull's time. Never committed.
- A pulled task holds its issue in its frontmatter, `jira: { site, id, key, updated, comments, parent?, digest, gone? }`, written by the plugin alone; never edit it.
- The API token is in `plugins/jira/credentials.json` in the Eidos app data folder, readable only by its owner, never in the root or a settings file.

### Commands

- `eidos jira login <site> [--global] [--email <email>]`: asks for the email and the API token (hidden; read from stdin without a terminal), checks them against Jira, keeps them. `logout <site>`, `whoami [--json]`.
- `eidos jira connect <name> --site <site> --project <KEY> [--board <id>] [--jql <jql>]`, `disconnect <name>`.
- `eidos jira describe <connection> [--refresh] [--json]`: the board's columns, issue types with statuses and fields, priorities, link types, sprints.
- `eidos jira map <connection> [--yes] [--json]`: a mapping drafted by names and categories; in a terminal each entry is asked, `--yes` accepts all, `--json` prints the draft (`{ entries: [{ part, jira, eidos, why }], unmatched: [] }`).
- `eidos jira configure:map <connection> set|unset <part> <from> [<to>]`: one entry; parts are `types`, `statuses`, `priorities`, `link_types`, `fields` (`{ jira: <field id>, eidos: title|status|priority|assignee|milestone|parent|property:<name>|section:<key> }`), and `parent` (`subtasks`, the default: only a Jira sub-task becomes a Backlog subtask; `all`; `none`).
- `eidos jira fetch [<connection>] [--full] [--json]`: what a pull would do; writes nothing to the root. JSON: `[{ connection, since, add, change, local, comments, people, gone, back, left_out, attachments, milestones, unchanged }]`.
- `eidos jira pull [<connection>] [--dry-run] [--full] [--keep-local] [--json]`: does it. JSON: `[{ connection, added, changed, kept_local, comments, people, gone, attachments, left_out }]`.

### Working it as an agent

Fetch before you pull and show the person what the fetch found, above all the tasks it names as edited here (`!` lines): a pull overwrites those fields unless `--keep-local` is passed. Never edit a pulled task's `jira` key, and never change a ticket in Jira from here. Run `--full` after a mapping changes, since a pull otherwise reads only the issues Jira changed.
