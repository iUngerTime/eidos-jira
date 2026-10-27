// Requests to one Jira Cloud site (Jira REQ16 to REQ19): REST v3 under
// `/rest/api/3/`, the Agile API under `/rest/agile/1.0/`, basic auth with the
// person's email and API token, straight from this machine to the site. A 429
// waits as long as Jira's `Retry-After` says and tries again, a few times; a
// failure names the connection, what was asked, and Jira's status and message,
// and never the token.

export class JiraError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
  }
}

export interface Credentials {
  email: string;
  token: string;
}

const RETRIES = 4;

// The address a site's requests go to. A site is `<name>.atlassian.net`; a
// full `http://localhost:<port>` or `http://127.0.0.1:<port>` is taken too,
// for a fake Jira in tests, and nothing else is.
export function siteBase(site: string): string {
  const given = site.trim().replace(/\/+$/, '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(given)) return given;
  const host = given.replace(/^https:\/\//, '');
  if (!/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i.test(host)) throw new JiraError(`'${site}' is not a Jira Cloud site: <name>.atlassian.net`, null);
  return `https://${host.toLowerCase()}`;
}

export interface Requester {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  bytes(url: string): Promise<Uint8Array>;
}

export function jiraClient(site: string, credentials: Credentials, label: string, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Requester {
  const base = siteBase(site);
  const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')}`;

  const send = async (method: string, url: string, body?: unknown, raw = false): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: { authorization, accept: raw ? '*/*' : 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'follow',
        });
      } catch (cause) {
        throw new JiraError(`${label}: ${method} ${url.replace(base, '')} did not reach ${base}: ${cause instanceof Error ? cause.message : String(cause)}`, null);
      }
      if (response.status === 429 && attempt < RETRIES) {
        const seconds = Number(response.headers.get('retry-after'));
        await wait((Number.isFinite(seconds) && seconds > 0 ? seconds : 2 ** attempt) * 1000);
        continue;
      }
      if (!response.ok) throw new JiraError(`${label}: ${method} ${url.replace(base, '')} answered ${response.status}: ${await reason(response)}`, response.status);
      return response;
    }
  };

  const address = (path: string, query: Record<string, string | number | undefined> = {}): string => {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  };

  return {
    get: async <T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> => (await send('GET', address(path, query))).json() as Promise<T>,
    post: async <T>(path: string, body: unknown): Promise<T> => (await send('POST', address(path), body)).json() as Promise<T>,
    bytes: async (url: string): Promise<Uint8Array> => {
      // an attachment is read from the site itself, never from an address that points elsewhere
      const target = new URL(url, base);
      if (target.origin !== new URL(base).origin) throw new JiraError(`${label}: an attachment at ${target.origin} is not on ${base}`, null);
      return new Uint8Array(await (await send('GET', target.toString(), undefined, true)).arrayBuffer());
    },
  };
}

// What Jira said was wrong, from its error body: its messages, else the status text.
async function reason(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string>; message?: string };
    const messages = [...(body.errorMessages ?? []), ...Object.entries(body.errors ?? {}).map(([key, value]) => `${key}: ${value}`), ...(body.message ? [body.message] : [])];
    if (messages.length > 0) return messages.join('; ');
  } catch {
    // not JSON: the status text says it
  }
  return response.statusText || 'no message';
}
