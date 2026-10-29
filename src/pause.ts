// What runs on its own stops asking Jira once Jira refuses the person (Jira
// REQ23): a refused sign-in pauses every connection on its site, a board or
// project refused or not found pauses its connection. Auto fetch and auto
// sync skip a paused connection without a request, so a lost token or a
// revoked board is never asked again at each interval or each save. The
// pause is kept in the connection's local state; signing in to the site
// again, Resume, or a fetch, pull, or sync the person asks for that succeeds
// lifts it.
import type { Host } from 'eidosmd/plugin';
import { JiraError } from './client.ts';
import { connections, SignInError, siteKey, type Connection } from './connections.ts';
import { readState, writeState } from './pull.ts';

export interface Pause {
  connection: string;
  at: string;
  // Jira's status, or null when no request was sent (nobody signed in, the token gone)
  status: number | null;
  reason: string;
}

// The refusal an error is, or null for a failure worth trying again (the network, Jira down, a limit).
// `connectionWide` is false where a 403 or 404 names one issue rather than the board (a sync of one task).
export function refusalOf(error: unknown, connectionWide: boolean): { status: number | null; site: boolean; reason: string } | null {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof SignInError) return { status: null, site: true, reason };
  if (!(error instanceof JiraError)) return null;
  if (error.status === 401) return { status: 401, site: true, reason };
  if (connectionWide && (error.status === 403 || error.status === 404)) return { status: error.status, site: false, reason };
  return null;
}

export function pauseOf(host: Host, name: string): Pause | null {
  const paused = readState(host.workspace, name).paused;
  return paused ? { connection: name, ...paused } : null;
}

export function pauses(host: Host): Pause[] {
  return connections(host)
    .map((entry) => pauseOf(host, entry.name))
    .filter((entry): entry is Pause => entry !== null);
}

// The connection paused for the refusal, and with a refused sign-in every other on its site; answers the ones newly paused.
export function pause(host: Host, connection: Connection, refusal: { status: number | null; site: boolean; reason: string }): string[] {
  const held = refusal.site ? connections(host).filter((entry) => siteKey(entry.site) === siteKey(connection.site)) : [connection];
  const fresh: string[] = [];
  const at = new Date().toISOString();
  for (const entry of held) {
    const state = readState(host.workspace, entry.name);
    if (!state.paused) fresh.push(entry.name);
    writeState(host.workspace, entry.name, { ...state, paused: { at, status: refusal.status, reason: refusal.reason } });
  }
  // named once: a connection already paused is not announced again
  for (const entry of held.filter((each) => fresh.includes(each.name)))
    host.emit('paused', { connection: entry.name, title: entry.title ?? entry.project, reason: refusal.reason, status: refusal.status });
  if (fresh.length > 0) host.emit('changed', {});
  return fresh;
}

// The pause lifted from each connection named; answers whether any was paused.
export function lift(host: Host, names: string[]): boolean {
  let lifted = false;
  for (const name of names) {
    const state = readState(host.workspace, name);
    if (!state.paused) continue;
    const { paused: _paused, ...rest } = state;
    writeState(host.workspace, name, rest);
    lifted = true;
  }
  if (lifted) host.emit('changed', {});
  return lifted;
}

// Every connection on a site, for a sign-in made again there.
export const onSite = (host: Host, site: string): string[] =>
  connections(host)
    .filter((entry) => siteKey(entry.site) === siteKey(site))
    .map((entry) => entry.name);
