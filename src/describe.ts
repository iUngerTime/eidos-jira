// What a mapping is made against (Jira REQ6): the board's columns and their
// statuses, the project's issue types with their statuses and fields, the
// priorities, the link types, and the board's sprints, read from Jira and
// kept per connection in the plugin's `local/` folder with when it was read.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Requester } from './client.ts';
import type { Connection } from './connections.ts';
import type { StatusCategory } from './types.ts';

export interface JiraStatus {
  id: string;
  name: string;
  category: StatusCategory;
}

export interface JiraField {
  id: string;
  name: string;
  // the schema's type (string, number, date, datetime, option, array, user, priority, ...), and an array's item type
  type: string;
  items?: string;
  // the custom field's kind, which says a sprint or a rich text field
  custom?: string;
  system?: string;
  required: boolean;
  allowed?: string[];
}

export interface JiraType {
  id: string;
  name: string;
  subtask: boolean;
  statuses: JiraStatus[];
  fields: JiraField[];
}

export interface Description {
  connection: string;
  read: string;
  columns: Array<{ name: string; statuses: string[] }>;
  types: JiraType[];
  priorities: string[];
  link_types: Array<{ name: string; outward: string; inward: string }>;
  sprints: Array<{ id: number; name: string; state: string; end: string | null }>;
  // the filter's JQL when the connection names a board
  filter: string | null;
  // the id of the field that holds an issue's sprints, when the site has one
  sprint_field: string | null;
}

// Jira's three status categories as the Backlog names them.
export function categoryOf(key: unknown): StatusCategory {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in_progress';
  return 'todo';
}

interface Paged<T> {
  values?: T[];
  isLast?: boolean;
  total?: number;
  startAt?: number;
  maxResults?: number;
}

async function all<T>(client: Requester, url: string, query: Record<string, string | number | undefined> = {}, key: 'values' | 'fields' | 'issueTypes' = 'values'): Promise<T[]> {
  const out: T[] = [];
  for (let startAt = 0; ;) {
    const page = await client.get<Paged<T> & Record<string, unknown>>(url, { ...query, startAt, maxResults: 100 });
    const items = (page[key] as T[] | undefined) ?? page.values ?? [];
    out.push(...items);
    const done = page.isLast === true || items.length === 0 || (page.total !== undefined && out.length >= page.total) || (page.isLast === undefined && page.total === undefined);
    if (done) return out;
    startAt += items.length;
  }
}

const SPRINT = 'com.pyxis.greenhopper.jira:gh-sprint';

export async function readDescription(client: Requester, connection: Connection): Promise<Description> {
  let columns: Description['columns'] = [];
  let filter: string | null = null;
  const statusNames = new Map<string, string>();
  const projectStatuses = await client.get<Array<{ id: string; name: string; subtask: boolean; statuses: Array<{ id: string; name: string; statusCategory?: { key?: string } }> }>>(
    `/rest/api/3/project/${encodeURIComponent(connection.project)}/statuses`,
  );
  for (const type of projectStatuses) for (const status of type.statuses) statusNames.set(status.id, status.name);
  if (connection.board !== undefined) {
    const configuration = await client.get<{ filter?: { id?: string }; columnConfig?: { columns?: Array<{ name: string; statuses?: Array<{ id: string }> }> } }>(
      `/rest/agile/1.0/board/${connection.board}/configuration`,
    );
    columns = (configuration.columnConfig?.columns ?? []).map((column) => ({ name: column.name, statuses: (column.statuses ?? []).map((status) => statusNames.get(status.id) ?? status.id) }));
    if (configuration.filter?.id) filter = (await client.get<{ jql?: string }>(`/rest/api/3/filter/${configuration.filter.id}`)).jql ?? null;
  }
  const created = await all<{ id: string; name: string; subtask?: boolean }>(client, `/rest/api/3/issue/createmeta/${encodeURIComponent(connection.project)}/issuetypes`, {}, 'issueTypes');
  const types: JiraType[] = [];
  let sprintField: string | null = null;
  for (const type of created) {
    const fields = await all<{
      fieldId: string;
      key?: string;
      name: string;
      required?: boolean;
      schema?: { type?: string; items?: string; custom?: string; system?: string };
      allowedValues?: Array<{ name?: string; value?: string }>;
    }>(client, `/rest/api/3/issue/createmeta/${encodeURIComponent(connection.project)}/issuetypes/${type.id}`, {}, 'fields');
    const statuses = projectStatuses.find((held) => held.id === type.id)?.statuses ?? [];
    types.push({
      id: type.id,
      name: type.name,
      subtask: type.subtask === true,
      statuses: statuses.map((status) => ({ id: status.id, name: status.name, category: categoryOf(status.statusCategory?.key) })),
      fields: fields.map((field) => {
        const allowed = (field.allowedValues ?? []).map((value) => value.name ?? value.value).filter((value): value is string => typeof value === 'string');
        if (field.schema?.custom === SPRINT) sprintField = field.fieldId ?? field.key ?? null;
        return {
          id: field.fieldId ?? field.key ?? '',
          name: field.name,
          type: field.schema?.type ?? 'any',
          ...(field.schema?.items ? { items: field.schema.items } : {}),
          ...(field.schema?.custom ? { custom: field.schema.custom } : {}),
          ...(field.schema?.system ? { system: field.schema.system } : {}),
          required: field.required === true,
          ...(allowed.length > 0 ? { allowed } : {}),
        };
      }),
    });
  }
  const priorities = (await all<{ name: string }>(client, '/rest/api/3/priority/search')).map((priority) => priority.name);
  const links = await client.get<{ issueLinkTypes?: Array<{ name: string; outward: string; inward: string }> }>('/rest/api/3/issueLinkType');
  const sprints =
    connection.board === undefined
      ? []
      : (await all<{ id: number; name: string; state: string; endDate?: string; completeDate?: string }>(client, `/rest/agile/1.0/board/${connection.board}/sprint`).catch(() => [])).map((sprint) => ({
          id: sprint.id,
          name: sprint.name,
          state: sprint.state,
          end: (sprint.completeDate ?? sprint.endDate ?? null)?.slice(0, 10) ?? null,
        }));
  return {
    connection: connection.name,
    read: new Date().toISOString(),
    columns,
    types,
    priorities,
    link_types: (links.issueLinkTypes ?? []).map((type) => ({ name: type.name, outward: type.outward, inward: type.inward })),
    sprints,
    filter,
    sprint_field: sprintField,
  };
}

const fileFor = (workspace: string, name: string): string => path.join(workspace, 'local', `describe-${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}.json`);

export function cachedDescription(workspace: string, name: string): Description | null {
  const file = fileFor(workspace, name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Description;
  } catch {
    return null;
  }
}

export function keepDescription(workspace: string, description: Description): void {
  const file = fileFor(workspace, description.connection);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(description, null, 2)}\n`);
}

// Every Jira status a description names, once each, with its category.
export function allStatuses(description: Description): JiraStatus[] {
  const out = new Map<string, JiraStatus>();
  for (const type of description.types) for (const status of type.statuses) if (!out.has(status.name)) out.set(status.name, status);
  return [...out.values()];
}

// Every field a description names, once each.
export function allFields(description: Description): JiraField[] {
  const out = new Map<string, JiraField>();
  for (const type of description.types) for (const field of type.fields) if (!out.has(field.id)) out.set(field.id, field);
  return [...out.values()];
}
