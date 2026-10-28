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
- `eidos jira configure:map <connection> set|unset <part> <from> [<to>] [--types <a,b>]`: one entry; parts are `types`, `statuses`, `priorities`, `link_types`, `fields` (`{ jira: <field id>, eidos: title|status|priority|assignee|milestone|parent|property:<name>|section:<key>, types? }`), and `parent` (`subtasks`, the default: only a Jira sub-task becomes a Backlog subtask; `all`; `none`). `--types` makes a field pair hold for those issue types alone, beside or in place of the field's pair for every type: an epic's field can go somewhere a bug's does not.
- `eidos jira fetch [<connection>] [--full] [--json]`: what a pull would do; writes nothing to the root. JSON: `[{ connection, since, add, change, local, comments, people, gone, back, left_out, attachments, milestones, unchanged }]`.
- `eidos jira pull [<connection>] [--dry-run] [--full] [--keep-local] [--json]`: does it. JSON: `[{ connection, added, changed, kept_local, comments, people, gone, attachments, left_out }]`.

### Setting a connection up, or changing it

The Backlog comes first: Jira's values map onto what the Backlog declares, so it needs its statuses, task types, priorities, and link types before a board is mapped. In the app, the person does all of this from the plugin's settings page (Mapping…); from a terminal, walk it with them:

1. Read both sides. The Backlog's: `eidos backlog types --json`, `properties --json`, and `link-types`, and its statuses, columns, and priorities in `.eidos/plugins/backlog/settings.yaml` (its defaults where that file leaves them out); `eidos jira describe <connection> --json` for Jira's (`--refresh` after the board changed).
2. Propose each part as a table, a row per Jira value and the Backlog value it would go to, and let the person change any row before you write it: issue types (a sub-task type usually to the default type, filed by the parent rule), statuses (by name, else by category; any status may go anywhere, an Intake to Done included), priorities (by name, else by rank from the highest), link types. `eidos jira map <connection> --json` gives a draft to start from. A value the Backlog lacks is added there first (`eidos backlog configure:status add …`), not left out silently.
3. Fields per issue type. The issue types do not share their fields: look at each type's list in `describe`, and where a field means something different per type (a story's points, an epic's target date), write a pair per type with `--types`. A field with nowhere to go gets a property, declared with `eidos backlog configure:property add <name> --type <type>` and, for a Jira field with a closed set, `--options` holding Jira's values: Number for a number, Date or Date & time for a date, List for an array or the sprints, Text otherwise (with options for a single choice).
4. Check it. `eidos check` reports each problem the mapping has as a `jira/` finding (a pair whose field cannot be carried there, an option the property lacks, a target the Backlog does not declare); fix every one. Then `eidos jira fetch <connection> --json` and show the person what a pull would add and change.
5. Ask before anything is pulled. After a mapping changes on a connection that has pulled before, pull with `--full`.

### Working it as an agent

Fetch before you pull and show the person what the fetch found, above all the tasks it names as edited here (`!` lines): a pull overwrites those fields unless `--keep-local` is passed. Never edit a pulled task's `jira` key, and never change a ticket in Jira from here. Run `--full` after a mapping changes, since a pull otherwise reads only the issues Jira changed.
