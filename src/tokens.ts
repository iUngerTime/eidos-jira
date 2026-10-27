// What this machine keeps of a person's Jira sign-ins (Jira REQ4, D-B46): one
// file, `plugins/jira/credentials.json` in the Eidos app data folder, outside
// every root, readable only by its owner. It holds each API token, and the
// email a site signs in with on every root of this machine (`login --global`).
// The same file on every operating system, found as the CLI finds the app
// data folder; EIDOS_APP_DATA moves it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env['EIDOS_APP_DATA']) return path.resolve(env['EIDOS_APP_DATA']);
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'eidosmd');
  if (platform === 'win32') return path.join(env['APPDATA'] ?? path.join(homedir(), 'AppData', 'Roaming'), 'eidosmd');
  return path.join(env['XDG_CONFIG_HOME'] ? path.resolve(env['XDG_CONFIG_HOME']) : path.join(homedir(), '.config'), 'eidosmd');
}

export const tokensFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(appDataDir(env), 'plugins', 'jira', 'credentials.json');

interface Held {
  // a site's email for every root on this machine, by site
  accounts: Record<string, string>;
  // each token, by site and email
  tokens: Record<string, string>;
}

const strings = (value: unknown): Record<string, string> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};

function read(file: string): Held {
  if (!existsSync(file)) return { accounts: {}, tokens: {} };
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return { accounts: strings(held['accounts']), tokens: strings(held['tokens']) };
  } catch {
    return { accounts: {}, tokens: {} };
  }
}

// Written whole to a file beside it, then moved over it, so a failed write
// never leaves half a file; owner-only on macOS and Linux (Windows keeps the
// app data folder to its user already).
function write(file: string, held: Held): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify(held, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, file);
  chmodSync(file, 0o600);
}

export interface TokenStore {
  readonly where: string;
  get(key: string): string | null;
  set(key: string, token: string): void;
  delete(key: string): boolean;
  // the email each site signs in with on every root of this machine
  accounts(): Record<string, string>;
  setAccount(site: string, email: string | null): void;
}

export function tokenStore(env: NodeJS.ProcessEnv = process.env): TokenStore {
  const file = tokensFile(env);
  return {
    where: file,
    get: (key) => read(file).tokens[key] ?? null,
    set: (key, token) => {
      const held = read(file);
      write(file, { ...held, tokens: { ...held.tokens, [key]: token } });
    },
    delete: (key) => {
      const held = read(file);
      if (!(key in held.tokens)) return false;
      delete held.tokens[key];
      write(file, held);
      return true;
    },
    accounts: () => read(file).accounts,
    setAccount: (site, email) => {
      const held = read(file);
      if (email === null) delete held.accounts[site];
      else held.accounts[site] = email;
      write(file, held);
    },
  };
}
