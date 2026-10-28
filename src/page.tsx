// The Jira plugin's page half (The Plugin Model REQ49), drawn with the kit the
// Eidos MD page hands a plugin (`eidosmd/page`) and laid out with its Stack,
// Row, and Text, never with utility classes. Two things: a Jira activity in
// the Activity Bar whose sidebar fetches and pulls each board, and the
// plugin's own settings page in place of the host's form (signing in,
// connecting a board by pasting its address, the mapping review, and the
// options). Each answers through the plugin's own routes.
import { useCallback, useEffect, useRef, useState, type JSX, type MutableRefObject } from 'react';
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
  Seg,
  SegItem,
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
interface EditorField {
  id: string;
  name: string;
  kind: string;
  targets: string[];
  property: { type: string; options?: string[] };
}
interface Choice {
  types: Record<string, string>;
  statuses: Record<string, string>;
  priorities: Record<string, string>;
  link_types: Record<string, string>;
  fields: Array<{ type: string; jira: string; eidos: string }>;
  parent: 'subtasks' | 'all' | 'none';
}
// what the plugin's `model` route answers (its EditorModel)
interface Model {
  connection: string;
  read: string;
  types: Array<{ name: string; subtask: boolean; statuses: string[]; fields: EditorField[] }>;
  statuses: Array<{ name: string; category: 'todo' | 'in_progress' | 'done' }>;
  priorities: string[];
  link_types: string[];
  backlog: { types: string[]; statuses: string[]; priorities: string[]; link_types: string[]; properties: Array<{ name: string; type: string }> };
  suggested: Partial<Record<Tab, Pair[]>>;
  chosen: Choice;
}
interface Stage {
  step: string;
  name?: string;
  n?: number;
  of?: number;
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
// the editor's tabs, statuses first as the part a person most often changes
const TABS = ['statuses', 'types', 'priorities', 'link_types', 'fields'] as const;
type Tab = (typeof TABS)[number];
// the Backlog's property types a property made for a field may take (its Object is not one)
const PROPERTY_TYPES = ['Text', 'List', 'Number', 'Checkbox', 'Date', 'Date & time'];

// a refusal's words, as the host's error carries them
const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const mappedCount = (connection: ConnectionRow): number => PARTS.reduce((sum, part) => sum + (Array.isArray(connection.mapping[part]) ? (connection.mapping[part] as Pair[]).length : 0), 0);
const planCount = (plan: Plan): number => plan.add.length + plan.change.length + plan.gone.length;

// The plugin's mark in the Activity Bar: two arrows chasing each other round, a board kept in step with Jira, drawn as
// the host draws its own icons.
function JiraIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.25 6.5A5.5 5.5 0 0 0 3.4 4.4" />
      <path d="M3 1.75V4.75H6" />
      <path d="M2.75 9.5a5.5 5.5 0 0 0 9.85 2.1" />
      <path d="M13 14.25V11.25H10" />
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

// The host is made again whenever the page's own state changes (a Backlog setting written, for one); a read made once per
// page or per board reaches it through this, so it is not made again each time.
function useHostRef(host: PluginHost): MutableRefObject<PluginHost> {
  const ref = useRef(host);
  ref.current = host;
  return ref;
}

function useJiraState(): { state: State | null; setState: (next: State) => void; reload: () => void } {
  const host = useHostRef(usePluginHost());
  const [state, setState] = useState<State | null>(null);
  const reload = useCallback(() => {
    host.current.get<State>('state').then(setState, (cause) => host.current.toast(host.current.t('loadFailed'), 'error', reason(cause)));
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

// The mapping editor (Jira REQ12): every value Jira holds beside the Backlog value it maps to, the held pair or a
// suggestion first, each changeable; fields per issue type, with a property made on the spot for a field none fits.
// While Jira is read, each stage of the read is shown as it starts.
function Mapping(props: { name: string; onClose: () => void; onSaved: (answer: { state: State }) => void }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const [model, setModel] = useState<Model | null>(null);
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('statuses');
  const [saving, setSaving] = useState(false);
  const hostRef = useHostRef(host);
  const read = useCallback(
    (refresh: boolean) => {
      setModel(null);
      setStages([]);
      setError(null);
      hostRef.current.get<Model>(`model?name=${encodeURIComponent(props.name)}${refresh ? '&refresh=true' : ''}`).then(
        (next) => {
          setModel(next);
          setChosen(next.chosen);
        },
        (cause) => setError(reason(cause)),
      );
    },
    [hostRef, props.name],
  );
  useEffect(() => read(false), [read]);
  usePluginEvent('describe', (payload) => {
    const stage = payload as Stage & { connection?: string };
    if (stage.connection === props.name) setStages((held) => [...held, stage]);
  });

  const save = async (): Promise<void> => {
    if (!chosen) return;
    setSaving(true);
    try {
      const answer = await host.put<{ problems: Array<{ message: string }>; state: State }>('mapping', { name: props.name, mapping: chosen });
      props.onSaved(answer);
      if (answer.problems.length > 0) host.toast(t('mappingProblems', { n: answer.problems.length }), 'error', answer.problems[0]!.message);
      else host.toast(t('mappingSaved'), 'success', props.name);
      props.onClose();
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
    } finally {
      setSaving(false);
    }
  };

  let body: JSX.Element;
  if (error) body = <Notice>{error}</Notice>;
  else if (!model || !chosen) body = <Reading stages={stages} />;
  else
    body = (
      <Stack gap="md">
        <Notice>
          <Stack gap="xs">
            <Text size="sm" block>
              {t('backlogFirst')}
            </Text>
            <Row>
              <Button size="sm" onClick={() => host.navigate('/plugins/backlog')}>
                {t('openBacklog')}
              </Button>
            </Row>
          </Stack>
        </Notice>
        {tab === 'fields' ? (
          <Fields model={model} chosen={chosen} setChosen={setChosen} setModel={setModel} connection={props.name} />
        ) : (
          <Values tab={tab} model={model} chosen={chosen} setChosen={setChosen} />
        )}
      </Stack>
    );
  return (
    <Modal
      size="lg"
      title={t('mappingTitle', { name: props.name })}
      onClose={props.onClose}
      head={
        model ? (
          <Seg>
            {TABS.map((each) => (
              <SegItem key={each} active={tab === each} onClick={() => setTab(each)}>
                {t(`part_${each}`)}
              </SegItem>
            ))}
          </Seg>
        ) : null
      }
      foot={
        <Row justify="between">
          <Row>
            {model && (
              <Text size="xs" tone="faint">
                {t('readFrom', { date: new Date(model.read).toLocaleString() })}
              </Text>
            )}
            <Button size="sm" variant="quiet" disabled={!model} onClick={() => read(true)}>
              {t('readAgain')}
            </Button>
          </Row>
          <Row>
            <Button variant="quiet" onClick={props.onClose}>
              {t('cancel')}
            </Button>
            <Button variant="primary" disabled={saving || !model || !chosen} onClick={() => void save()} data-testid="jira-save-mapping">
              {t(saving ? 'savingMapping' : 'saveMapping')}
            </Button>
          </Row>
        </Row>
      }
    >
      <Card variant="home">{body}</Card>
    </Modal>
  );
}

// What is being asked of Jira, a line per stage begun, the last one still going.
function Reading(props: { stages: Stage[] }): JSX.Element {
  const { t } = usePluginHost();
  if (props.stages.length === 0)
    return (
      <Stack>
        <Text tone="faint">{t('readingBoard')}</Text>
        <SkeletonBar width="60%" />
      </Stack>
    );
  // an issue type's line stands in for the one before it, so seven types are one line counting up
  const lines = props.stages.filter((stage, at) => !(stage.step === 'type' && props.stages[at + 1]?.step === 'type'));
  return (
    <Stack gap="xs" data-testid="jira-reading">
      {lines.map((stage, at) => {
        const last = at === lines.length - 1;
        return (
          <Text key={`${stage.step}${stage.n ?? ''}`} size="sm" tone={last ? 'default' : 'faint'} block>
            {last ? '… ' : '✓ '}
            {t(`stage_${stage.step}`, { name: stage.name ?? '', n: stage.n ?? 0, of: stage.of ?? 0 })}
          </Text>
        );
      })}
      <SkeletonBar width="60%" />
    </Stack>
  );
}

// Issue types, statuses, priorities, or link types: a row per Jira value, "maps to", and the Backlog's values.
function Values(props: { tab: Exclude<Tab, 'fields'>; model: Model; chosen: Choice; setChosen: (next: Choice) => void }): JSX.Element {
  const { t } = usePluginHost();
  const { model, chosen, tab } = props;
  const set = (jira: string, eidos: string): void => props.setChosen({ ...chosen, [tab]: { ...chosen[tab], [jira]: eidos } });
  const suggestion = (jira: string): string => model.suggested[tab]?.find((pair) => pair.jira.toLowerCase() === jira.toLowerCase())?.eidos ?? '';
  let rows: Array<{ jira: string; hint: string }>;
  let targets: string[];
  // a status always lands somewhere (its category), the others may be left out
  let empty: string | null = t('notCarried');
  if (tab === 'types') {
    rows = model.types.map((type) => ({ jira: type.name, hint: t(type.subtask ? 'jiraSubtask' : 'jiraType') }));
    targets = model.backlog.types;
  } else if (tab === 'statuses') {
    rows = model.statuses.map((status) => ({
      jira: status.name,
      hint: t('jiraStatus', {
        category: t(`category_${status.category}`),
        types: model.types
          .filter((type) => type.statuses.includes(status.name))
          .map((type) => type.name)
          .join(', '),
      }),
    }));
    targets = model.backlog.statuses;
    empty = null;
  } else if (tab === 'priorities') {
    rows = model.priorities.map((priority, at) => ({ jira: priority, hint: t('jiraPriority', { n: at + 1, of: model.priorities.length }) }));
    targets = model.backlog.priorities;
    empty = t('noPriority');
  } else {
    rows = model.link_types.map((type) => ({ jira: type, hint: t('jiraLink') }));
    targets = model.backlog.link_types;
  }
  if (targets.length === 0) return <Notice>{t(`backlogHasNo_${tab}`)}</Notice>;
  return (
    <Stack gap="sm">
      <Card variant="grouped">
        {rows.map((row) => {
          const proposed = suggestion(row.jira);
          return (
            <SettingRow
              key={row.jira}
              label={row.jira}
              hint={proposed ? `${row.hint} · ${t('suggested', { value: proposed })}` : row.hint}
              control={
                <Row>
                  <Text size="sm" tone="muted">
                    {t('mapsTo')}
                  </Text>
                  <Select aria-label={t('mapsToLabel', { jira: row.jira })} value={chosen[tab][row.jira] ?? ''} onChange={(event: { target: HTMLSelectElement }) => set(row.jira, event.target.value)}>
                    {empty !== null && <option value="">{empty}</option>}
                    {targets.map((target) => (
                      <option key={target} value={target}>
                        {target}
                      </option>
                    ))}
                  </Select>
                </Row>
              }
            />
          );
        })}
        {tab === 'types' && (
          <SettingRow
            label={t('parentRule')}
            hint={t('parentRuleHint')}
            control={
              <Select
                aria-label={t('parentRule')}
                value={chosen.parent}
                onChange={(event: { target: HTMLSelectElement }) => props.setChosen({ ...chosen, parent: event.target.value as Choice['parent'] })}
              >
                {(['subtasks', 'all', 'none'] as const).map((rule) => (
                  <option key={rule} value={rule}>
                    {t(`parent_${rule}`)}
                  </option>
                ))}
              </Select>
            }
          />
        )}
      </Card>
    </Stack>
  );
}

// the choice that makes a property instead of naming one; no target starts with +
const NEW_PROPERTY = '+new';

// A target as the person reads it: a field of the task, a section, or a property.
function targetLabel(t: PluginHost['t'], target: string): string {
  const [head, name = ''] = target.split(/:(.*)/s);
  if (head === 'section' || head === 'property') return t(`target_${head}`, { name });
  return t(`target_${target}`);
}

// One issue type's fields at a time, each mapped to where it lands on a task; a change goes to every issue type
// holding the field unless the person keeps it to this one.
function Fields(props: { model: Model; chosen: Choice; setChosen: (next: Choice) => void; setModel: (next: Model) => void; connection: string }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const { model, chosen } = props;
  const [type, setType] = useState(model.types.find((each) => !each.subtask)?.name ?? model.types[0]?.name ?? '');
  const [together, setTogether] = useState(true);
  const [making, setMaking] = useState<{ field: EditorField; name: string; type: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = model.types.find((each) => each.name === type);
  const placeOf = (typeName: string, jira: string): string => chosen.fields.find((pair) => pair.type === typeName && pair.jira === jira)?.eidos ?? '';
  const setPlace = (jira: string, eidos: string): void => {
    const over = together ? model.types.filter((each) => each.fields.some((field) => field.id === jira)).map((each) => each.name) : [type];
    const rest = chosen.fields.filter((pair) => !(pair.jira === jira && over.includes(pair.type)));
    props.setChosen({ ...chosen, fields: eidos ? [...rest, ...over.map((each) => ({ type: each, jira, eidos }))] : rest });
  };
  const differs = (jira: string): boolean => new Set(model.types.filter((each) => each.fields.some((field) => field.id === jira)).map((each) => placeOf(each.name, jira))).size > 1;
  const create = async (): Promise<void> => {
    if (!making) return;
    setBusy(true);
    try {
      const next = await host.post<Model>('property', {
        connection: props.connection,
        name: making.name,
        type: making.type,
        options: ['Text', 'List'].includes(making.type) ? (making.field.property.options ?? []) : [],
      });
      props.setModel({ ...next, chosen });
      setPlace(making.field.id, `property:${making.name}`);
      host.toast(t('propertyCreated', { name: making.name }), 'success');
      setMaking(null);
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!shown) return <Text tone="faint">{t('noTypes')}</Text>;
  return (
    <Stack gap="sm">
      <Row wrap>
        <Text size="sm" tone="muted">
          {t('fieldsOf')}
        </Text>
        <Select aria-label={t('fieldsOf')} value={type} onChange={(event: { target: HTMLSelectElement }) => setType(event.target.value)}>
          {model.types.map((each) => (
            <option key={each.name} value={each.name}>
              {each.name}
            </option>
          ))}
        </Select>
        <Switch checked={together} aria-label={t('together')} onChange={(event: { currentTarget: HTMLInputElement }) => setTogether(event.currentTarget.checked)} />
        <Text size="sm">{t('together')}</Text>
      </Row>
      <Card variant="grouped">
        {shown.fields.map((field) => [
          <SettingRow
            key={field.id}
            label={field.name}
            hint={t('fieldHint', { id: field.id, kind: t(`kind_${field.kind}`) })}
            badge={differs(field.id) ? <Badge>{t('differs')}</Badge> : null}
            control={
              <Row>
                <Text size="sm" tone="muted">
                  {t('mapsTo')}
                </Text>
                <Select
                  aria-label={t('mapsToLabel', { jira: field.name })}
                  value={placeOf(type, field.id)}
                  onChange={(event: { target: HTMLSelectElement }) => {
                    if (event.target.value === NEW_PROPERTY)
                      setMaking({
                        field,
                        name: field.name
                          .replace(/[^A-Za-z0-9_-]+/g, '_')
                          .replace(/^_+|_+$/g, '')
                          .toLowerCase(),
                        type: field.property.type,
                      });
                    else setPlace(field.id, event.target.value);
                  }}
                >
                  <option value="">{t('notCarried')}</option>
                  {field.targets.map((target) => (
                    <option key={target} value={target}>
                      {targetLabel(t, target)}
                    </option>
                  ))}
                  <option value={NEW_PROPERTY}>{t('newProperty')}</option>
                </Select>
              </Row>
            }
          />,
          making?.field.id === field.id ? (
            <SettingRow
              key={`${field.id}:new`}
              stacked
              data-testid="jira-new-property"
              label={t('newPropertyTitle', { field: making.field.name })}
              hint={making.field.property.options ? t('propertyOptions', { options: making.field.property.options.join(', ') }) : null}
              control={
                <Row wrap>
                  <Input
                    aria-label={t('propertyName')}
                    placeholder={t('propertyName')}
                    value={making.name}
                    onChange={(event: { target: HTMLInputElement }) => setMaking({ ...making, name: event.target.value })}
                  />
                  <Select aria-label={t('propertyType')} value={making.type} onChange={(event: { target: HTMLSelectElement }) => setMaking({ ...making, type: event.target.value })}>
                    {PROPERTY_TYPES.map((each) => (
                      <option key={each} value={each}>
                        {each}
                      </option>
                    ))}
                  </Select>
                  <Button variant="quiet" onClick={() => setMaking(null)}>
                    {t('cancel')}
                  </Button>
                  <Button variant="primary" disabled={busy || !making.name.trim()} onClick={() => void create()}>
                    {t('createProperty')}
                  </Button>
                </Row>
              }
            />
          ) : null,
        ])}
      </Card>
    </Stack>
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
