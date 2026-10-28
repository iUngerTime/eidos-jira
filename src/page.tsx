// The Jira plugin's page half (The Plugin Model REQ49): its own settings page,
// drawn with the kit the Eidos MD page hands a plugin (`eidosmd/page`), in
// place of the host's form. Sign in to a site, connect a board by pasting its
// address, review the drafted mapping, fetch and pull, and the options, each
// answered by the plugin's own routes.
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Badge, Button, Card, Input, Modal, Notice, Select, SettingRow, SettingsHead, Switch, usePluginHost, type PagePlugin } from 'eidosmd/page';
import { JIRA_STRINGS } from './page-strings.ts';

interface SignInRow {
  site: string;
  email: string | null;
  kept: string | null;
  scope: 'environment' | 'root' | 'machine' | null;
}
interface Pair {
  jira: string;
  eidos: string;
}
interface ConnectionRow {
  name: string;
  site: string;
  project: string;
  board?: number;
  jql?: string;
  mapping: Record<string, Pair[] | string | undefined>;
  problems: Array<{ code: string; message: string }>;
  status: { last_pull: string | null; last_fetch: { at: string; count: number; error?: string } | null } | null;
}
interface State {
  sign_ins: SignInRow[];
  connections: ConnectionRow[];
  settings: { pull_attachments: boolean; add_people: boolean; auto_fetch: string };
}
interface DraftEntry {
  part: string;
  jira: string;
  eidos: string;
  why: string;
}
interface Plan {
  connection: string;
  add: unknown[];
  change: unknown[];
  comments: { add: number; change: number; remove: number };
  people: string[];
  gone: unknown[];
  attachments: number;
}
interface Done {
  connection: string;
  added: number;
  changed: number;
  comments: { added: number; changed: number; removed: number };
  people: number;
  gone: number;
}

const PARTS = ['types', 'statuses', 'priorities', 'link_types', 'fields'] as const;

// a refusal's words, as the host's error carries them
const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function JiraSettings(): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string | null>(null);
  const load = useCallback(() => host.get<State>('state').then(setState), [host]);
  useEffect(() => {
    void load().catch((cause) => host.toast(t('loadFailed'), 'error', reason(cause)));
  }, [load, host, t]);

  // one action against a route, its button busy meanwhile, its refusal said in a toast
  const act = async <T,>(key: string, work: () => Promise<T>, done?: (value: T) => void): Promise<void> => {
    setBusy(key);
    try {
      const value = await work();
      done?.(value);
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
    } finally {
      setBusy(null);
    }
  };
  const take = (answer: { state: State }): void => setState(answer.state);

  if (!state) return <p className="text-faint">{t('loading')}</p>;
  return (
    <div className="flex flex-col gap-6" data-testid="jira-settings">
      <Account state={state} busy={busy} act={act} take={take} />
      <Boards state={state} busy={busy} act={act} take={take} onMap={setMapping} />
      <Options state={state} act={act} take={take} />
      {mapping && <Mapping name={mapping} onClose={() => setMapping(null)} onSaved={take} />}
    </div>
  );
}

type Act = <T>(key: string, work: () => Promise<T>, done?: (value: T) => void) => Promise<void>;

function Account(props: { state: State; busy: string | null; act: Act; take: (answer: { state: State }) => void }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const [site, setSite] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [global, setGlobal] = useState(false);
  const signIn = (): void =>
    void props.act(
      'login',
      () => host.post<{ signed: { site: string; name: string }; state: State }>('login', { site: site || props.state.connections[0]?.site || '', email, token, global }),
      (answer) => {
        props.take(answer);
        setToken('');
        host.toast(t('signedIn', { name: answer.signed.name }), 'success', answer.signed.site);
      },
    );
  return (
    <section>
      <SettingsHead>{t('account')}</SettingsHead>
      <Card variant="grouped">
        {props.state.sign_ins.map((row) => (
          <SettingRow
            key={row.site}
            label={row.site}
            hint={row.email ? t('signedInAs', { email: row.email, kept: row.kept ?? '' }) : t('nobodySignedIn')}
            badge={row.email ? <Badge>{t('signedInBadge')}</Badge> : null}
            control={
              row.email && row.scope !== 'environment' ? (
                <Button
                  disabled={props.busy === `logout:${row.site}`}
                  onClick={() => void props.act(`logout:${row.site}`, () => host.post<{ state: State }>('logout', { site: row.site }), props.take)}
                >
                  {t('signOut')}
                </Button>
              ) : null
            }
          />
        ))}
        <SettingRow
          stacked
          label={t('signInTitle')}
          hint={
            <>
              {t('signInHint')}{' '}
              <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
                {t('makeToken')}
              </a>
            </>
          }
          control={
            <div className="flex flex-col gap-2">
              <Input placeholder={t('sitePlaceholder')} aria-label={t('site')} value={site} onChange={(event: { target: HTMLInputElement }) => setSite(event.target.value)} />
              <Input placeholder={t('emailPlaceholder')} aria-label={t('email')} type="email" value={email} onChange={(event: { target: HTMLInputElement }) => setEmail(event.target.value)} />
              <Input
                placeholder={t('tokenPlaceholder')}
                aria-label={t('token')}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event: { target: HTMLInputElement }) => setToken(event.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={global} aria-label={t('everyRoot')} onChange={(event: { currentTarget: HTMLInputElement }) => setGlobal(event.currentTarget.checked)} />
                {t('everyRoot')}
              </label>
              <div>
                <Button variant="primary" disabled={props.busy === 'login' || !email.trim() || !token.trim()} onClick={signIn} data-testid="jira-sign-in">
                  {t(props.busy === 'login' ? 'signingIn' : 'signIn')}
                </Button>
              </div>
            </div>
          }
        />
      </Card>
    </section>
  );
}

function Boards(props: { state: State; busy: string | null; act: Act; take: (answer: { state: State }) => void; onMap: (name: string) => void }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const [address, setAddress] = useState('');
  const [result, setResult] = useState<Record<string, string>>({});
  const say = (name: string, words: string): void => setResult((held) => ({ ...held, [name]: words }));
  const planWords = (plan: Plan): string =>
    t('fetched', { add: plan.add.length, change: plan.change.length, comments: plan.comments.add + plan.comments.change + plan.comments.remove, gone: plan.gone.length });
  const doneWords = (done: Done): string => t('pulled', { added: done.added, changed: done.changed, comments: done.comments.added + done.comments.changed + done.comments.removed });
  const remove = async (name: string): Promise<void> => {
    if (!(await host.dialog.confirm(t('removeAsk', { name }), { title: t('removeTitle'), ok: t('remove'), danger: true }))) return;
    await props.act(`remove:${name}`, () => host.post<{ state: State }>('disconnect', { name }), props.take);
  };
  return (
    <section>
      <SettingsHead>{t('boards')}</SettingsHead>
      {props.state.connections.map((connection) => {
        const mapped = PARTS.reduce((sum, part) => sum + (Array.isArray(connection.mapping[part]) ? (connection.mapping[part] as Pair[]).length : 0), 0);
        return (
          <Card key={connection.name} data-testid={`jira-connection-${connection.name}`}>
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-md">{connection.name}</b>
              <span className="text-sm text-faint">{[connection.project, connection.site, connection.board ? t('board', { board: connection.board }) : null].filter(Boolean).join(' · ')}</span>
            </div>
            <p className="mt-1 mb-2 text-sm text-muted">
              {[
                mapped > 0 ? t('mappedCount', { n: mapped }) : t('notMapped'),
                connection.status?.last_pull ? t('lastPull', { date: new Date(connection.status.last_pull).toLocaleString() }) : t('neverPulled'),
              ].join(' · ')}
            </p>
            {connection.problems.map((problem) => (
              <Notice key={problem.code + problem.message}>{problem.message}</Notice>
            ))}
            {result[connection.name] && <p className="mt-0 mb-2 text-sm">{result[connection.name]}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={props.busy !== null}
                onClick={() =>
                  void props.act(
                    `fetch:${connection.name}`,
                    () => host.post<Plan[]>('fetch', { name: connection.name }),
                    (plans) => plans[0] && say(connection.name, planWords(plans[0])),
                  )
                }
              >
                {t(props.busy === `fetch:${connection.name}` ? 'fetching' : 'fetch')}
              </Button>
              <Button
                variant="primary"
                disabled={props.busy !== null || mapped === 0}
                onClick={() =>
                  void props.act(
                    `pull:${connection.name}`,
                    () => host.post<Done[]>('pull', { name: connection.name }),
                    (dones) => {
                      if (!dones[0]) return;
                      say(connection.name, doneWords(dones[0]));
                      host.toast(t('pulledTitle', { name: connection.name }), 'success', doneWords(dones[0]));
                      void host.get<State>('state').then((next) => props.take({ state: next }));
                    },
                  )
                }
              >
                {t(props.busy === `pull:${connection.name}` ? 'pulling' : 'pull')}
              </Button>
              <Button onClick={() => props.onMap(connection.name)}>{t('editMapping')}</Button>
              <Button variant="quiet" disabled={props.busy !== null} onClick={() => void remove(connection.name)}>
                {t('remove')}
              </Button>
            </div>
          </Card>
        );
      })}
      <Card variant="grouped">
        <SettingRow
          stacked
          label={t('addBoard')}
          hint={t('addBoardHint')}
          control={
            <div className="flex gap-2">
              <Input
                className="flex-1"
                placeholder={t('boardPlaceholder')}
                aria-label={t('boardAddress')}
                value={address}
                onChange={(event: { target: HTMLInputElement }) => setAddress(event.target.value)}
              />
              <Button
                disabled={props.busy === 'connect' || !address.trim()}
                onClick={() =>
                  void props.act(
                    'connect',
                    () => host.post<{ connection: { name: string }; state: State }>('connect', { url: address }),
                    (answer) => {
                      props.take(answer);
                      setAddress('');
                      props.onMap(answer.connection.name);
                    },
                  )
                }
                data-testid="jira-connect"
              >
                {t('connect')}
              </Button>
            </div>
          }
        />
      </Card>
    </section>
  );
}

// The drafted mapping as a review, as `eidos jira map` asks it: each proposed pair ticked to take or left, written together.
function Mapping(props: { name: string; onClose: () => void; onSaved: (answer: { state: State }) => void }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const [draft, setDraft] = useState<{ entries: DraftEntry[]; unmatched: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    host.get<{ entries: DraftEntry[]; unmatched: string[] }>(`draft?name=${encodeURIComponent(props.name)}`).then(
      (read) => {
        setDraft(read);
        setTaken(new Set(read.entries.map((_entry, index) => index)));
      },
      (cause) => setError(reason(cause)),
    );
  }, [host, props.name]);
  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    try {
      const entries = draft.entries.filter((_entry, index) => taken.has(index)).map(({ part, jira, eidos }) => ({ part, jira, eidos }));
      const answer = await host.post<{ state: State }>('accept', { name: props.name, entries });
      props.onSaved(answer);
      host.toast(t('mappingSaved', { n: entries.length }), 'success', props.name);
      props.onClose();
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
    } finally {
      setSaving(false);
    }
  };
  let body: JSX.Element;
  if (error) body = <Notice>{error}</Notice>;
  else if (!draft) body = <p className="text-faint">{t('readingBoard')}</p>;
  else if (draft.entries.length === 0) body = <p className="text-faint">{t('nothingToMap')}</p>;
  else
    body = (
      <div className="flex flex-col">
        {PARTS.filter((part) => draft.entries.some((entry) => entry.part === part)).map((part) => (
          <div key={part} className="mb-3">
            <SettingsHead>{t(`part_${part}`)}</SettingsHead>
            {draft.entries.map((entry, index) =>
              entry.part !== part ? null : (
                <label key={index} className="flex items-center gap-3 border-b border-line py-1.5 text-sm last:border-b-0">
                  <Switch
                    checked={taken.has(index)}
                    aria-label={`${entry.jira} → ${entry.eidos}`}
                    onChange={(event: { currentTarget: HTMLInputElement }) => {
                      const on = event.currentTarget.checked;
                      setTaken((held) => {
                        const next = new Set(held);
                        if (on) next.add(index);
                        else next.delete(index);
                        return next;
                      });
                    }}
                  />
                  <span className="flex-1">
                    <b>{entry.jira}</b> → {entry.eidos}
                  </span>
                  <span className="text-faint">{entry.why}</span>
                </label>
              ),
            )}
          </div>
        ))}
        {draft.unmatched.length > 0 && (
          <Notice>
            {t('unmatched')} {draft.unmatched.join('; ')}
          </Notice>
        )}
      </div>
    );
  return (
    <Modal
      size="lg"
      title={t('mappingTitle', { name: props.name })}
      onClose={props.onClose}
      foot={
        <div className="flex justify-end gap-2">
          <Button variant="quiet" onClick={props.onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={saving || !draft || draft.entries.length === 0} onClick={() => void save()} data-testid="jira-save-mapping">
            {t('saveMapping', { n: taken.size })}
          </Button>
        </div>
      }
    >
      <div className="p-4">{body}</div>
    </Modal>
  );
}

function Options(props: { state: State; act: Act; take: (answer: { state: State }) => void }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const write = (name: string, value: unknown): void => void props.act(`setting:${name}`, () => host.put<{ state: State }>('settings', { [name]: value }), props.take);
  const settings = props.state.settings;
  return (
    <section>
      <SettingsHead>{t('options')}</SettingsHead>
      <Card variant="grouped">
        <SettingRow
          label={t('pullAttachments')}
          hint={t('pullAttachmentsHint')}
          control={
            <Switch
              checked={settings.pull_attachments}
              aria-label={t('pullAttachments')}
              onChange={(event: { currentTarget: HTMLInputElement }) => write('pull_attachments', event.currentTarget.checked)}
            />
          }
        />
        <SettingRow
          label={t('addPeople')}
          hint={t('addPeopleHint')}
          control={<Switch checked={settings.add_people} aria-label={t('addPeople')} onChange={(event: { currentTarget: HTMLInputElement }) => write('add_people', event.currentTarget.checked)} />}
        />
        <SettingRow
          label={t('autoFetch')}
          hint={t('autoFetchHint')}
          control={
            <Select aria-label={t('autoFetch')} value={settings.auto_fetch} onChange={(event: { target: HTMLSelectElement }) => write('auto_fetch', event.target.value)}>
              {['off', '5', '15', '30', '60'].map((value) => (
                <option key={value} value={value}>
                  {value === 'off' ? t('autoFetchOff') : t('autoFetchEvery', { n: value })}
                </option>
              ))}
            </Select>
          }
        />
      </Card>
    </section>
  );
}

export const page: PagePlugin = {
  name: 'jira',
  strings: JIRA_STRINGS,
  settings: () => <JiraSettings />,
  settingsDrawn: ['connections', 'accounts', 'pull_attachments', 'add_people', 'auto_fetch'],
};
