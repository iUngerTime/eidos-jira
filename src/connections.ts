// A root's connections (Jira REQ2, REQ3, REQ7) and the person's credentials
// for each site (REQ4). A connection is an entry of the shared `connections`
// setting; the account a site signs in with is the person's, kept for this
// root (`accounts`, in the plugin's local.yaml) or for every root on this
// machine (in the plugin's credentials file in app data), its token in that
// same file and nowhere else. `JIRA_EMAIL` and
// `JIRA_API_TOKEN` in the environment come before both.
import type { Host } from 'eidosmd/plugin';
import { siteBase, type Credentials } from './client.ts';
import { tokenStore } from './tokens.ts';

export interface Pair {
  jira: string;
  eidos: string;
}

export type ParentRule = 'subtasks' | 'all' | 'none';

export interface Mapping {
  types?: Pair[];
  statuses?: Pair[];
  priorities?: Pair[];
  link_types?: Pair[];
  fields?: Pair[];
  parent?: ParentRule;
}

export const MAPPING_PARTS = ['types', 'statuses', 'priorities', 'link_types', 'fields'] as const;
export type MappingPart = (typeof MAPPING_PARTS)[number];

export interface Connection {
  name: string;
  site: string;
  project: string;
  board?: number;
  jql?: string;
  direction: 'pull' | 'push';
  restricted_comments?: boolean;
  mapping: Mapping;
}

export class ConnectionError extends Error {}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : typeof value === 'number' ? String(value) : undefined);

function readPairs(value: unknown): Pair[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    if (!plain(entry)) return [];
    const jira = text(entry['jira']);
    const eidos = text(entry['eidos']);
    return jira && eidos ? [{ jira, eidos }] : [];
  });
}

// One entry of `connections` read forgivingly: an entry with no name, site, or project is no connection.
export function readConnection(value: unknown): Connection | null {
  if (!plain(value)) return null;
  const name = text(value['name']);
  const site = text(value['site']);
  const project = text(value['project']);
  if (!name || !site || !project) return null;
  const mapping: Mapping = {};
  const held = plain(value['mapping']) ? value['mapping'] : {};
  for (const part of MAPPING_PARTS) {
    const pairs = readPairs(held[part]);
    if (pairs) mapping[part] = pairs;
  }
  const parent = text(held['parent']);
  if (parent === 'subtasks' || parent === 'all' || parent === 'none') mapping.parent = parent;
  const board = Number(value['board']);
  const jql = text(value['jql']);
  return {
    name,
    site,
    project: project.toUpperCase(),
    ...(Number.isInteger(board) && board > 0 ? { board } : {}),
    ...(jql ? { jql } : {}),
    direction: value['direction'] === 'push' ? 'push' : 'pull',
    ...(value['restricted_comments'] === true ? { restricted_comments: true } : {}),
    mapping,
  };
}

export function connections(host: Host): Connection[] {
  const held = host.settings().get<unknown>('connections');
  return (Array.isArray(held) ? held : []).map(readConnection).filter((entry): entry is Connection => entry !== null);
}

export function connection(host: Host, name: string): Connection {
  const found = connections(host).find((entry) => entry.name.toLowerCase() === name.trim().toLowerCase());
  if (!found) {
    const names = connections(host).map((entry) => entry.name);
    throw new ConnectionError(`no Jira connection '${name}' in this root${names.length > 0 ? ` (${names.join(', ')})` : '; eidos jira connect adds one'}`);
  }
  return found;
}

// Jira REQ3: one root never pulls and pushes the same issues. The connection
// that overlaps, by its project or its board, with the other direction.
export function opposed(all: Connection[], candidate: Connection): Connection | null {
  return (
    all.find(
      (other) =>
        other.name.toLowerCase() !== candidate.name.toLowerCase() &&
        other.direction !== candidate.direction &&
        siteKey(other.site) === siteKey(candidate.site) &&
        (other.project === candidate.project || (other.board !== undefined && other.board === candidate.board)),
    ) ?? null
  );
}

export async function writeConnections(host: Host, next: Connection[]): Promise<void> {
  for (const entry of next) {
    siteBase(entry.site);
    const clash = opposed(next, entry);
    if (clash)
      throw new ConnectionError(`${entry.name} would ${entry.direction} the issues ${clash.name} already ${clash.direction}s (${clash.project}); a root never pulls and pushes the same issues`);
  }
  const names = new Set<string>();
  for (const entry of next) {
    if (names.has(entry.name.toLowerCase())) throw new ConnectionError(`two connections are called ${entry.name}`);
    names.add(entry.name.toLowerCase());
  }
  await host.settings().set('connections', next);
}

// A site as an account is kept for it: lowercase, no scheme.
export const siteKey = (site: string): string =>
  site
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/+$/, '');

export type Scope = 'environment' | 'root' | 'machine';
export const SCOPE_WORDS: Record<Scope, string> = { environment: 'the environment', root: 'this root', machine: 'this machine' };

export interface SignIn {
  email: string;
  scope: Scope;
}

const accountsIn = (held: unknown): Record<string, string> =>
  plain(held) ? Object.fromEntries(Object.entries(held).flatMap(([site, email]) => (typeof email === 'string' && email.trim() !== '' ? [[siteKey(site), email.trim()]] : []))) : {};
const rootAccounts = (host: Host): Record<string, string> => accountsIn(host.settings().get<unknown>('accounts'));
const machineAccounts = (): Record<string, string> => accountsIn(tokenStore().accounts());

// Every site a sign-in is kept for here, this root's and this machine's, once each.
export function signedInSites(host: Host): string[] {
  return [...new Set([...Object.keys(rootAccounts(host)), ...Object.keys(machineAccounts())])];
}

// A board's address as Jira shows it (`https://acme.atlassian.net/jira/software/projects/ACME/boards/12`), read
// into the site, the project's key, and the board; null for anything else.
export function fromBoardUrl(address: string): { site: string; project: string; board: number | null } | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  const project = /\/projects\/([A-Za-z][A-Za-z0-9_]*)/.exec(url.pathname)?.[1];
  if (!project) return null;
  const board = /\/boards\/(\d+)/.exec(url.pathname)?.[1];
  return { site: url.host, project: project.toUpperCase(), board: board ? Number(board) : null };
}

// The token's key in the credentials file: one per site and account, so a
// site may be signed in with one account for this root and another for the machine.
export const secretKey = (site: string, email: string): string => `${siteKey(site)}/${email.toLowerCase()}`;

// Who signs in to a site and where that is kept, the environment first, then this root, then this machine.
export function signIn(host: Host, site: string, env: NodeJS.ProcessEnv = process.env): SignIn | null {
  if (env['JIRA_EMAIL']?.trim() && env['JIRA_API_TOKEN']?.trim()) return { email: env['JIRA_EMAIL'].trim(), scope: 'environment' };
  const key = siteKey(site);
  const root = rootAccounts(host)[key];
  if (root) return { email: root, scope: 'root' };
  const machine = machineAccounts()[key];
  if (machine) return { email: machine, scope: 'machine' };
  return null;
}

export function credentials(host: Host, site: string, env: NodeJS.ProcessEnv = process.env): Credentials {
  const found = signIn(host, site, env);
  if (!found) throw new ConnectionError(`nobody is signed in to ${siteKey(site)} here; eidos jira login ${siteKey(site)}`);
  if (found.scope === 'environment') return { email: found.email, token: env['JIRA_API_TOKEN']!.trim() };
  const token = tokenStore().get(secretKey(site, found.email));
  if (!token) throw new ConnectionError(`the token for ${found.email} on ${siteKey(site)} is not in ${tokenStore().where}; eidos jira login ${siteKey(site)}`);
  return { email: found.email, token };
}

export async function saveSignIn(host: Host, site: string, given: Credentials, global: boolean): Promise<void> {
  tokenStore().set(secretKey(site, given.email), given.token);
  if (global) tokenStore().setAccount(siteKey(site), given.email);
  else await host.settings().set('accounts', { ...rootAccounts(host), [siteKey(site)]: given.email });
}

// The sign-in for a site taken out of this root and this machine, and its tokens from the file; who was signed out.
export async function removeSignIn(host: Host, site: string): Promise<string[]> {
  const key = siteKey(site);
  const out: string[] = [];
  const root = rootAccounts(host);
  const rootEmail = root[key];
  if (rootEmail) {
    tokenStore().delete(secretKey(site, rootEmail));
    delete root[key];
    await host.settings().set('accounts', root);
    out.push(`${rootEmail} (${SCOPE_WORDS.root})`);
  }
  const machineEmail = machineAccounts()[key];
  if (machineEmail) {
    tokenStore().delete(secretKey(site, machineEmail));
    tokenStore().setAccount(key, null);
    out.push(`${machineEmail} (${SCOPE_WORDS.machine})`);
  }
  return out;
}
