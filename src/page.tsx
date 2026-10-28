// The Jira plugin's page half (The Plugin Model REQ49), drawn with the kit the
// Eidos MD page hands a plugin (`eidosmd/page`) and laid out with its Stack,
// Row, and Text, never with utility classes. Two things: a Jira activity in
// the Activity Bar whose sidebar fetches and pulls each board, and the
// plugin's own settings page in place of the host's form (signing in,
// connecting a board by pasting its address, the mapping review, and the
// options). Each answers through the plugin's own routes.
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Nav,
  NavFoot,
  NavFootLink,
  NavHead,
  Notice,
  Row,
  Select,
  SettingRow,
  SettingsHead,
  SkeletonBar,
  Stack,
  Switch,
  Text,
  usePluginEvent,
  usePluginHost,
  type PagePlugin,
  type PluginHost,
} from 'eidosmd/page';
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
  gone: unknown[];
}
interface Done {
  connection: string;
  added: number;
  changed: number;
  comments: { added: number; changed: number; removed: number };
}

const PARTS = ['types', 'statuses', 'priorities', 'link_types', 'fields'] as const;

// a refusal's words, as the host's error carries them
const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const mappedCount = (connection: ConnectionRow): number => PARTS.reduce((sum, part) => sum + (Array.isArray(connection.mapping[part]) ? (connection.mapping[part] as Pair[]).length : 0), 0);
const planCount = (plan: Plan): number => plan.add.length + plan.change.length + plan.gone.length;

// The plugin's mark in the Activity Bar: a board with an arrow down into it, drawn as the host draws its own icons.
function JiraIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 9.5v3.25c0 .41.34.75.75.75h9.5c.41 0 .75-.34.75-.75V9.5" />
      <path d="M8 2.5v7.25M5.25 7 8 9.75 10.75 7" />
    </svg>
  );
}

// One action against a route, the key of the button it came from busy meanwhile, its refusal said in a toast.
function useActions(host: PluginHost): { busy: string | null; act: <T>(key: string, work: () => Promise<T>, done?: (value: T) => void) => Promise<void> } {
  const [busy, setBusy] = useState<string | null>(null);
  const act = useCallback(
    async <T,>(key: string, work: () => Promise<T>, done?: (value: T) => void): Promise<void> => {
      setBusy(key);
      try {
        done?.(await work());
      } catch (cause) {
        host.toast(host.t('failed'), 'error', reason(cause));
      } finally {
        setBusy(null);
      }
    },
    [host],
  );
  return { busy, act };
}

function useJiraState(): { state: State | null; setState: (next: State) => void; reload: () => void } {
  const host = usePluginHost();
  const [state, setState] = useState<State | null>(null);
  const reload = useCallback(() => {
    host.get<State>('state').then(setState, (cause) => host.toast(host.t('loadFailed'), 'error', reason(cause)));
  }, [host]);
  useEffect(reload, [reload]);
  // a fetch the app's server ran on its own (auto_fetch) reaches the page as this event
  usePluginEvent('fetched', reload);
  return { state, setState, reload };
}

// ---- the sidebar ------------------------------------------------------------------------

function JiraView(): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const { state, reload } = useJiraState();
  const { busy, act } = useActions(host);
  const [found, setFound] = useState<Record<string, number>>({});
  const fetchOne = (name: string): Promise<void> =>
    act(
      `fetch:${name}`,
      () => host.post<Plan[]>('fetch', { name }),
      (plans) => {
        if (plans[0]) setFound((held) => ({ ...held, [name]: planCount(plans[0]!) }));
      },
    );
  const pullOne = (name: string): Promise<void> =>
    act(
      `pull:${name}`,
      () => host.post<Done[]>('pull', { name }),
      (dones) => {
        const done = dones[0];
        if (!done) return;
        setFound((held) => ({ ...held, [name]: 0 }));
        host.toast(t('pulledTitle', { name }), 'success', t('pulled', { added: done.added, changed: done.changed, comments: done.comments.added + done.comments.changed + done.comments.removed }));
        reload();
      },
    );

  let body: JSX.Element;
  if (!state)
    body = (
      <Stack pad="sm">
        <SkeletonBar width="70%" />
        <SkeletonBar width="50%" />
      </Stack>
    );
  else if (state.connections.length === 0)
    body = (
      <Stack pad="sm">
        <Text size="sm" tone="muted" block>
          {t('noBoards')}
        </Text>
        <Row>
          <Button size="sm" onClick={() => host.navigate('/plugins/jira')}>
            {t('connectBoard')}
          </Button>
        </Row>
      </Stack>
    );
  else
    body = (
      <Stack gap="md" pad="sm">
        {state.connections.map((connection) => {
          const lastFetch = connection.status?.last_fetch;
          const waiting = found[connection.name] ?? (lastFetch && !lastFetch.error ? lastFetch.count : null);
          let line = t('notFetched');
          if (lastFetch?.error) line = t('fetchFailed', { error: lastFetch.error });
          else if (waiting === 0) line = t('upToDate');
          else if (waiting !== null && waiting !== undefined) line = t('toPull', { n: waiting });
          return (
            <Card key={connection.name} data-testid={`jira-board-${connection.name}`}>
              <Stack gap="xs">
                <Row>
                  <Text weight="strong" grow>
                    {connection.name}
                  </Text>
                  {waiting ? <Badge tone="accent">{waiting}</Badge> : null}
                </Row>
                <Text size="xs" tone="faint">
                  {[connection.project, connection.site].join(' · ')}
                </Text>
                <Text size="sm" tone={lastFetch?.error ? 'error' : 'muted'} block>
                  {line}
                </Text>
                <Text size="xs" tone="faint" block>
                  {connection.status?.last_pull ? t('lastPull', { date: new Date(connection.status.last_pull).toLocaleString() }) : t('neverPulled')}
                </Text>
                <Row>
                  <Button size="sm" disabled={busy !== null} onClick={() => void fetchOne(connection.name)}>
                    {t(busy === `fetch:${connection.name}` ? 'fetching' : 'fetch')}
                  </Button>
                  <Button size="sm" variant="primary" disabled={busy !== null || mappedCount(connection) === 0} onClick={() => void pullOne(connection.name)}>
                    {t(busy === `pull:${connection.name}` ? 'pulling' : 'pull')}
                  </Button>
                </Row>
              </Stack>
            </Card>
          );
        })}
      </Stack>
    );
  return (
    <Nav data-testid="jira-view">
      <NavHead>
        <b>{t('manifestTitle')}</b>
      </NavHead>
      {body}
      <NavFoot>
        <NavFootLink onClick={() => host.navigate('/plugins/jira')}>{t('openSettings')}</NavFootLink>
      </NavFoot>
    </Nav>
  );
}

// ---- the settings page ------------------------------------------------------------------

function JiraSettings(): JSX.Element {
  const host = usePluginHost();
  const { state, setState } = useJiraState();
  const { busy, act } = useActions(host);
  const [mapping, setMapping] = useState<string | null>(null);
  const take = (answer: { state: State }): void => setState(answer.state);
  if (!state)
    return (
      <Stack>
        <SkeletonBar width="40%" height={18} />
        <SkeletonBar width="80%" />
      </Stack>
    );
  return (
    <Stack gap="lg" data-testid="jira-settings">
      <Account state={state} busy={busy} act={act} take={take} />
      <Boards state={state} busy={busy} act={act} take={take} onMap={setMapping} />
      <Options state={state} act={act} take={take} />
      {mapping && <Mapping name={mapping} onClose={() => setMapping(null)} onSaved={take} />}
    </Stack>
  );
}

type Act = <T>(key: string, work: () => Promise<T>, done?: (value: T) => void) => Promise<void>;

function Account(props: { state: State; busy: string | null; act: Act; take: (answer: { state: State }) => void }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const known = props.state.connections[0]?.site ?? props.state.sign_ins[0]?.site ?? '';
  const [site, setSite] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [global, setGlobal] = useState(false);
  const signIn = (): void =>
    void props.act(
      'login',
      () => host.post<{ signed: { site: string; name: string }; state: State }>('login', { site: site.trim() || known, email, token, global }),
      (answer) => {
        props.take(answer);
        setToken('');
        host.toast(t('signedIn', { name: answer.signed.name }), 'success', answer.signed.site);
      },
    );
  return (
    <Stack gap="xs">
      <SettingsHead>{t('account')}</SettingsHead>
      <Card variant="grouped">
        {props.state.sign_ins.map((row) => (
          <SettingRow
            key={row.site}
            label={row.site}
            hint={row.email ? t('signedInAs', { email: row.email, kept: row.kept ?? '' }) : t('nobodySignedIn')}
            badge={row.email ? <Badge tone="ok">{t('signedInBadge')}</Badge> : null}
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
          hint={t('signInHint')}
          control={
            <Stack>
              <Input placeholder={known || t('sitePlaceholder')} aria-label={t('site')} value={site} onChange={(event: { target: HTMLInputElement }) => setSite(event.target.value)} />
              <Input placeholder={t('emailPlaceholder')} aria-label={t('email')} type="email" value={email} onChange={(event: { target: HTMLInputElement }) => setEmail(event.target.value)} />
              <Input
                placeholder={t('tokenPlaceholder')}
                aria-label={t('token')}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event: { target: HTMLInputElement }) => setToken(event.target.value)}
              />
              <Row>
                <Switch checked={global} aria-label={t('everyRoot')} onChange={(event: { currentTarget: HTMLInputElement }) => setGlobal(event.currentTarget.checked)} />
                <Text size="sm">{t('everyRoot')}</Text>
              </Row>
              <Row>
                <Button variant="primary" disabled={props.busy === 'login' || !email.trim() || !token.trim() || !(site.trim() || known)} onClick={signIn} data-testid="jira-sign-in">
                  {t(props.busy === 'login' ? 'signingIn' : 'signIn')}
                </Button>
                <Button variant="quiet" onClick={() => window.open('https://id.atlassian.com/manage-profile/security/api-tokens', '_blank', 'noopener')}>
                  {t('makeToken')}
                </Button>
              </Row>
            </Stack>
          }
        />
      </Card>
    </Stack>
  );
}

function Boards(props: { state: State; busy: string | null; act: Act; take: (answer: { state: State }) => void; onMap: (name: string) => void }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const [address, setAddress] = useState('');
  const remove = async (name: string): Promise<void> => {
    if (!(await host.dialog.confirm(t('removeAsk', { name }), { title: t('removeTitle'), ok: t('remove'), danger: true }))) return;
    await props.act(`remove:${name}`, () => host.post<{ state: State }>('disconnect', { name }), props.take);
  };
  return (
    <Stack gap="xs">
      <SettingsHead>{t('boards')}</SettingsHead>
      <Card variant="grouped">
        {props.state.connections.map((connection) => {
          const mapped = mappedCount(connection);
          return (
            <SettingRow
              key={connection.name}
              data-testid={`jira-connection-${connection.name}`}
              label={connection.name}
              hint={[connection.project, connection.site, connection.board ? t('board', { board: connection.board }) : null, mapped > 0 ? t('mappedCount', { n: mapped }) : t('notMapped')]
                .filter(Boolean)
                .join(' · ')}
              control={
                <Row>
                  <Button onClick={() => props.onMap(connection.name)}>{t('editMapping')}</Button>
                  <Button variant="quiet" disabled={props.busy !== null} onClick={() => void remove(connection.name)}>
                    {t('remove')}
                  </Button>
                </Row>
              }
            />
          );
        })}
        <SettingRow
          stacked
          label={t('addBoard')}
          hint={t('addBoardHint')}
          control={
            <Row>
              <Input placeholder={t('boardPlaceholder')} aria-label={t('boardAddress')} value={address} onChange={(event: { target: HTMLInputElement }) => setAddress(event.target.value)} />
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
            </Row>
          }
        />
      </Card>
      {props.state.connections.flatMap((connection) =>
        connection.problems.map((problem) => (
          <Notice key={connection.name + problem.code + problem.message}>
            {connection.name}: {problem.message}
          </Notice>
        )),
      )}
    </Stack>
  );
}

// The drafted mapping as a review, as `eidos jira map` asks it: each proposed pair switched on to take it, written together.
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
      props.onSaved(await host.post<{ state: State }>('accept', { name: props.name, entries }));
      host.toast(t('mappingSaved', { n: entries.length }), 'success', props.name);
      props.onClose();
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
    } finally {
      setSaving(false);
    }
  };
  const toggle = (index: number, on: boolean): void =>
    setTaken((held) => {
      const next = new Set(held);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  let body: JSX.Element;
  if (error) body = <Notice>{error}</Notice>;
  else if (!draft) body = <Text tone="faint">{t('readingBoard')}</Text>;
  else if (draft.entries.length === 0) body = <Text tone="faint">{t('nothingToMap')}</Text>;
  else
    body = (
      <Stack gap="md">
        {PARTS.filter((part) => draft.entries.some((entry) => entry.part === part)).map((part) => (
          <Stack key={part} gap="xs">
            <SettingsHead>{t(`part_${part}`)}</SettingsHead>
            <Card variant="grouped">
              {draft.entries.map((entry, index) =>
                entry.part !== part ? null : (
                  <SettingRow
                    key={index}
                    label={`${entry.jira} → ${entry.eidos}`}
                    hint={entry.why}
                    control={
                      <Switch
                        checked={taken.has(index)}
                        aria-label={`${entry.jira} → ${entry.eidos}`}
                        onChange={(event: { currentTarget: HTMLInputElement }) => toggle(index, event.currentTarget.checked)}
                      />
                    }
                  />
                ),
              )}
            </Card>
          </Stack>
        ))}
        {draft.unmatched.length > 0 && (
          <Notice>
            {t('unmatched')} {draft.unmatched.join('; ')}
          </Notice>
        )}
      </Stack>
    );
  return (
    <Modal
      size="lg"
      title={t('mappingTitle', { name: props.name })}
      onClose={props.onClose}
      foot={
        <Row justify="end">
          <Button variant="quiet" onClick={props.onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={saving || !draft || draft.entries.length === 0} onClick={() => void save()} data-testid="jira-save-mapping">
            {t('saveMapping', { n: taken.size })}
          </Button>
        </Row>
      }
    >
      <Card variant="home">{body}</Card>
    </Modal>
  );
}

function Options(props: { state: State; act: Act; take: (answer: { state: State }) => void }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const write = (name: string, value: unknown): void => void props.act(`setting:${name}`, () => host.put<{ state: State }>('settings', { [name]: value }), props.take);
  const settings = props.state.settings;
  return (
    <Stack gap="xs">
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
    </Stack>
  );
}

export const page: PagePlugin = {
  name: 'jira',
  strings: JIRA_STRINGS,
  views: [{ sector: 'primary', name: 'boards', title: 'Jira', icon: JiraIcon, render: () => <JiraView /> }],
  settings: () => <JiraSettings />,
  settingsDrawn: ['connections', 'accounts', 'pull_attachments', 'add_people', 'auto_fetch'],
};
