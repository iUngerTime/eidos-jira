// The Jira plugin's page half (The Plugin Model REQ49), drawn with the kit the
// Eidos MD page hands a plugin (`eidosmd/page`) and laid out with its Stack,
// Row, and Text, never with utility classes. Three things: a Jira activity in
// the Activity Bar whose sidebar fetches and pulls each board, the plugin's
// own settings page in place of the host's form (signing in, connecting a
// board by pasting its address, and the options), and a page of its own per
// board for its mapping, at /p/jira/mapping/<board>. Each answers through the
// plugin's own routes.
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
  Page,
  PageHead,
  PageText,
  PageTitle,
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
  useOpen,
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
  // the tasks edited here since their last pull or sync, and the creates and syncs cut short
  sync: { edited: Array<{ task: string; key: string; sides: string[] }>; pending: string[]; interrupted: Array<{ key: string; at: string }> } | null;
}
// an account whose token this machine keeps
interface HeldRow {
  site: string;
  email: string;
  default: boolean;
  picked: boolean;
}
interface State {
  sign_ins: SignInRow[];
  held: HeldRow[];
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

// what the plugin's `sync-plan` route answers (its SyncPlan)
interface SyncPlanView {
  task: string;
  key: string;
  url: string;
  fields: Array<{ side: string; jira: string; verdict: 'unchanged' | 'from-jira' | 'to-jira' | 'same' | 'conflict'; eidos: string; remote: string; seen: string; reason?: string; kept?: boolean }>;
  status: { from: string; to: string; path: string[] } | null;
  comments: Array<{ index: number; text: string }>;
  blockers: Blocker[];
  loss: Record<string, Array<{ kind: string; count: number }>>;
  level: boolean;
}
// what stops a sync or a create, and what the page offers to settle it
interface Ask {
  kind: 'status_to' | 'via' | 'field' | 'type';
  field?: string;
  choices: string[];
}
interface Blocker {
  side: string | null;
  code: string;
  message: string;
  fix: string;
  ask?: Ask;
}
// what the plugin's `task` route answers for the open file (its TaskLink)
interface TaskLink {
  task: string;
  title: string;
  key: string | null;
  url: string | null;
  connection: string | null;
  pending: boolean;
  skipped: boolean;
}
// what the plugin's `create-plan` route answers (its CreatePlan), and what a create settles
interface CreatePlanView {
  task: string;
  connection: string;
  type: string | null;
  fields: Array<{ jira: string; value: string; from: 'task' | 'default' | 'option' }>;
  parent: string | null;
  later: string[];
  blockers: Blocker[];
  recovering: boolean;
}
interface CreateChoices {
  type?: string;
  fields: Record<string, string>;
}
// what a review settles, sent with every plan it asks for and with the sync
interface SyncChoices {
  take: Record<string, 'jira' | 'eidos'>;
  accept_loss: string[];
  status_to?: string;
  via?: string[];
  fields: Record<string, string>;
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
  // a fetch the app's server ran on its own (auto_fetch) reaches the page as this event, a sync, create, or skip as the next
  usePluginEvent('fetched', reload);
  usePluginEvent('changed', reload);
  return { state, setState, reload };
}

// ---- the sidebar ------------------------------------------------------------------------

function JiraView(): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const { state, reload } = useJiraState();
  const { busy, act } = useActions(host);
  const [found, setFound] = useState<Record<string, number>>({});
  const [reviewing, setReviewing] = useState<string | null>(null);
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
                {(connection.sync?.edited.length ?? 0) > 0 && (
                  <Stack gap="xs" data-testid={`jira-edited-${connection.name}`}>
                    <Text size="xs" tone="muted" block>
                      {t('editedHere', { n: connection.sync!.edited.length })}
                    </Text>
                    {connection.sync!.edited.map((edited) => (
                      <Row key={edited.task}>
                        <Text size="sm" grow>
                          {edited.key}
                        </Text>
                        <Button size="sm" variant="quiet" disabled={busy !== null} onClick={() => setReviewing(edited.task)}>
                          {t('review')}
                        </Button>
                      </Row>
                    ))}
                  </Stack>
                )}
                {(connection.sync?.interrupted ?? []).map((cut) => (
                  <Text key={cut.key} size="xs" tone="error" block>
                    {t('syncCutShort', { key: cut.key })}
                  </Text>
                ))}
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
      {reviewing && (
        <SyncReview
          task={reviewing}
          onClose={() => setReviewing(null)}
          onSynced={() => {
            setReviewing(null);
            reload();
          }}
        />
      )}
      <NavFoot>
        <NavFootLink onClick={() => host.navigate('/plugins/jira')}>{t('openSettings')}</NavFootLink>
      </NavFoot>
    </Nav>
  );
}

// ---- the sync review --------------------------------------------------------------------

// One task's sync as the person reviews it (Jira Sync REQ3, REQ4): each field that moves, a side chosen for each
// conflict, a status or a screen's value chosen where the sync asks, a loss agreed to, and Sync once nothing is left.
function SyncReview(props: { task: string; onClose: () => void; onSynced: () => void }): JSX.Element {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const [choices, setChoices] = useState<SyncChoices>({ take: {}, accept_loss: [], fields: {} });
  const [plan, setPlan] = useState<SyncPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // read again after a refused sync, so what Jira changed meanwhile is shown to settle
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    hostRef.current.post<SyncPlanView>('sync-plan', { task: props.task, options: choices }).then(
      (next) => {
        if (live) setPlan(next);
      },
      (cause) => {
        if (live) setError(reason(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [hostRef, props.task, choices, round]);
  const sync = async (): Promise<void> => {
    setSyncing(true);
    try {
      // what this review read of Jira goes with it, so a field Jira changed meanwhile stops the sync instead of being written over
      await host.post('sync', { task: props.task, options: { ...choices, expect: Object.fromEntries((plan?.fields ?? []).map((field) => [field.side, field.seen])) } });
      host.toast(t('syncedTitle', { key: plan?.key ?? props.task }), 'success');
      props.onSynced();
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
      setRound((held) => held + 1);
    } finally {
      setSyncing(false);
    }
  };
  const arrow: Record<SyncPlanView['fields'][number]['verdict'], string> = { unchanged: '', 'from-jira': '←', 'to-jira': '→', same: '=', conflict: '!' };
  let body: JSX.Element;
  if (error) body = <Notice>{error}</Notice>;
  else if (!plan)
    body = (
      <Stack pad="sm">
        <SkeletonBar width="70%" />
        <SkeletonBar width="50%" />
      </Stack>
    );
  else
    body = (
      <Stack gap="sm">
        {plan.level && (
          <Text size="sm" tone="muted" block>
            {t('syncLevel')}
          </Text>
        )}
        {plan.fields
          .filter((field) => field.verdict !== 'unchanged')
          .map((field) => (
            <Stack key={field.side} gap="xs">
              <Row>
                <Text weight="strong">{arrow[field.verdict]}</Text>
                <Text size="sm" grow>
                  {field.side}
                </Text>
                {field.verdict === 'conflict' && (
                  <Seg>
                    <SegItem selected={choices.take[field.side] === 'jira'} onClick={() => setChoices({ ...choices, take: { ...choices.take, [field.side]: 'jira' } })}>
                      {t('keepJira')}
                    </SegItem>
                    <SegItem selected={choices.take[field.side] === 'eidos'} onClick={() => setChoices({ ...choices, take: { ...choices.take, [field.side]: 'eidos' } })}>
                      {t('keepMine')}
                    </SegItem>
                  </Seg>
                )}
              </Row>
              <Text size="xs" tone="faint" block>
                {field.verdict === 'from-jira' && t('fromJira', { value: field.remote })}
                {field.verdict === 'to-jira' && (field.kept ? t('keptHere', { reason: field.reason ?? '' }) : t('toJira', { value: field.eidos }))}
                {field.verdict === 'same' && t('sameBoth')}
                {field.verdict === 'conflict' && t('bothChanged', { here: field.eidos, jira: field.remote })}
              </Text>
            </Stack>
          ))}
        {plan.status && (
          <Text size="sm" block>
            {t('statusPath', { path: [plan.status.from, ...plan.status.path].join(' → ') })}
          </Text>
        )}
        {plan.comments.map((comment) => (
          <Text key={comment.index} size="sm" block>
            {t('sendsComment', { text: comment.text })}
          </Text>
        ))}
        {plan.blockers
          .filter((blocker) => blocker.code !== 'conflict' && blocker.code !== 'unrecorded')
          .map((blocker) => (
            <Notice key={blocker.message}>
              <Stack gap="xs">
                <Text size="sm" block>
                  {blocker.message}
                </Text>
                {blocker.code === 'loss' && blocker.side && (
                  <Row>
                    <Switch
                      checked={choices.accept_loss.includes(blocker.side)}
                      aria-label={t('acceptLoss')}
                      onChange={(event: { currentTarget: HTMLInputElement }) =>
                        setChoices({
                          ...choices,
                          accept_loss: event.currentTarget.checked ? [...choices.accept_loss, blocker.side!] : choices.accept_loss.filter((side) => side !== blocker.side),
                        })
                      }
                    />
                    <Text size="sm">{t('acceptLoss')}</Text>
                  </Row>
                )}
                {blocker.ask ? (
                  <BlockerAsk
                    ask={blocker.ask}
                    onChoose={(value) => {
                      if (blocker.ask!.kind === 'status_to') setChoices({ ...choices, status_to: value });
                      else if (blocker.ask!.kind === 'via') setChoices({ ...choices, via: [...(choices.via ?? []), value] });
                      else setChoices({ ...choices, fields: { ...choices.fields, [blocker.ask!.field ?? '']: value } });
                    }}
                  />
                ) : (
                  blocker.code !== 'loss' && (
                    <Text size="xs" tone="faint" block>
                      {blocker.fix}
                    </Text>
                  )
                )}
              </Stack>
            </Notice>
          ))}
      </Stack>
    );
  const unsettled = plan === null || plan.blockers.length > 0;
  return (
    <Modal
      size="lg"
      title={t('syncTitle', { key: plan?.key ?? props.task })}
      onClose={props.onClose}
      foot={
        <Row justify="between">
          <Row>
            {plan && (
              <Button size="sm" variant="quiet" onClick={() => window.open(plan.url, '_blank', 'noopener')}>
                {t('openInJira')}
              </Button>
            )}
            {(choices.via?.length ?? 0) > 0 || choices.status_to ? (
              <Button size="sm" variant="quiet" onClick={() => setChoices({ ...choices, via: [], status_to: undefined })}>
                {t('resetStatus')}
              </Button>
            ) : null}
          </Row>
          <Row>
            <Button variant="quiet" onClick={props.onClose}>
              {t('cancel')}
            </Button>
            <Button variant="primary" disabled={syncing || unsettled || plan.level} onClick={() => void sync()} data-testid="jira-sync">
              {t(syncing ? 'syncing' : 'sync')}
            </Button>
          </Row>
        </Row>
      }
    >
      <Card variant="home">{body}</Card>
    </Modal>
  );
}

// What a blocker asks the person for: one of the values Jira lists, or a value typed where it lists none.
function BlockerAsk(props: { ask: Ask; onChoose: (value: string) => void }): JSX.Element {
  const { t } = usePluginHost();
  const [typed, setTyped] = useState('');
  if (props.ask.choices.length > 0)
    return (
      <Select
        aria-label={t(`ask_${props.ask.kind}`)}
        value=""
        onChange={(event: { target: HTMLSelectElement }) => {
          if (event.target.value) props.onChoose(event.target.value);
        }}
      >
        <option value="">{t(`ask_${props.ask.kind}`)}</option>
        {props.ask.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </Select>
    );
  const label = t('fieldValue', { field: props.ask.field ?? '' });
  return (
    <Row>
      <Input placeholder={label} aria-label={label} value={typed} onChange={(event: { target: HTMLInputElement }) => setTyped(event.target.value)} />
      <Button size="sm" disabled={!typed.trim()} onClick={() => props.onChoose(typed.trim())}>
        {t('setValue')}
      </Button>
    </Row>
  );
}

// The task the open file holds, as the ticket panel offers it to sync or to create, read again whenever `again` changes.
function useTaskLink(again: unknown): TaskLink | null {
  const host = useHostRef(usePluginHost());
  const open = useOpen() as { file?: string };
  const file = open.file ?? null;
  const [link, setLink] = useState<TaskLink | null>(null);
  useEffect(() => {
    if (!file) {
      setLink(null);
      return;
    }
    let live = true;
    host.current.get<{ task: TaskLink | null }>(`task?file=${encodeURIComponent(file)}`).then(
      (answer) => {
        if (live) setLink(answer.task);
      },
      () => {
        if (live) setLink(null);
      },
    );
    return () => {
      live = false;
    };
  }, [host, file, again]);
  return link;
}

// ---- the ticket panel -------------------------------------------------------------------

// The open ticket's own standing with Jira, in the auxiliary sidebar beside it: whether it is in Jira, what a sync would
// carry each way, and its Sync, Create, and Don't sync, one ticket at a time.
function TicketView(): JSX.Element {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const { busy, act } = useActions(host);
  const [round, setRound] = useState(0);
  const again = (): void => setRound((held) => held + 1);
  const link = useTaskLink(round);
  const [connections, setConnections] = useState<string[]>([]);
  const [plan, setPlan] = useState<SyncPlanView | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  usePluginEvent('fetched', again);
  usePluginEvent('changed', again);
  useEffect(() => {
    hostRef.current.get<State>('state').then(
      (state) => setConnections(state.connections.map((connection) => connection.name)),
      () => setConnections([]),
    );
  }, [hostRef, round]);
  // what a sync would do, read from Jira as the ticket opens: a read, nothing sent
  const syncable = link?.key && link.connection && !link.skipped ? link.task : null;
  useEffect(() => {
    setPlan(null);
    setPlanError(null);
    if (!syncable) return;
    let live = true;
    hostRef.current.post<SyncPlanView>('sync-plan', { task: syncable, options: { take: {}, accept_loss: [], fields: {} } }).then(
      (next) => {
        if (live) setPlan(next);
      },
      (cause) => {
        if (live) setPlanError(reason(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [hostRef, syncable, round]);
  if (!link)
    return (
      <Stack pad="sm">
        <Text size="sm" tone="faint" block>
          {t('openTaskHint')}
        </Text>
      </Stack>
    );
  const arrow: Record<SyncPlanView['fields'][number]['verdict'], string> = { unchanged: '', 'from-jira': '←', 'to-jira': '→', same: '=', conflict: '!' };
  const moving = plan?.fields.filter((field) => field.verdict !== 'unchanged' && field.verdict !== 'same') ?? [];
  let standing: JSX.Element | null = null;
  if (link.skipped)
    standing = (
      <Text size="sm" tone="muted" block>
        {t('skippedHere')}
      </Text>
    );
  else if (!link.key)
    standing = (
      <Text size="sm" tone="muted" block>
        {link.pending ? t('createCutShort') : t('notInJira')}
      </Text>
    );
  else if (!link.connection)
    standing = (
      <Text size="sm" tone="error" block>
        {t('noBoardReaches')}
      </Text>
    );
  else if (planError)
    standing = (
      <Text size="sm" tone="error" block>
        {planError}
      </Text>
    );
  else if (!plan)
    standing = (
      <Stack>
        <SkeletonBar width="70%" />
        <SkeletonBar width="50%" />
      </Stack>
    );
  else if (moving.length === 0)
    standing = (
      <Text size="sm" tone="muted" block>
        {t('levelHere')}
      </Text>
    );
  else
    standing = (
      <Stack gap="xs" data-testid="jira-ticket-fields">
        {moving.map((field) => (
          <Stack key={field.side} gap="xs">
            <Row>
              <Text weight="strong">{arrow[field.verdict]}</Text>
              <Text size="sm" grow>
                {field.side}
              </Text>
            </Row>
            <Text size="xs" tone="faint" block>
              {field.verdict === 'from-jira' && t('fromJira', { value: field.remote })}
              {field.verdict === 'to-jira' && (field.kept ? t('keptHere', { reason: field.reason ?? '' }) : t('toJira', { value: field.eidos }))}
              {field.verdict === 'conflict' && t('bothChanged', { here: field.eidos, jira: field.remote })}
            </Text>
          </Stack>
        ))}
        {plan.blockers.length > 0 && (
          <Text size="xs" tone="muted" block>
            {t('toSettle', { n: plan.blockers.length })}
          </Text>
        )}
      </Stack>
    );
  return (
    <Stack gap="md" pad="sm" data-testid="jira-ticket">
      <Stack gap="xs">
        <Row>
          <Text weight="strong" grow>
            {link.key ?? link.task}
          </Text>
          {moving.length > 0 ? <Badge tone="accent">{moving.length}</Badge> : null}
        </Row>
        <Text size="sm" tone="muted" block>
          {link.title}
        </Text>
      </Stack>
      {standing}
      {!link.skipped && (
        <Row>
          {link.key ? (
            <>
              <Button size="sm" variant="primary" disabled={busy !== null || !link.connection} onClick={() => setReviewing(true)} data-testid="jira-sync-task">
                {t('syncWithJira')}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => window.open(link.url!, '_blank', 'noopener')}>
                {t('openInJira')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" disabled={busy !== null || connections.length === 0} onClick={() => setCreating(true)} data-testid="jira-create-task">
              {t(link.pending ? 'finishCreate' : 'createInJira')}
            </Button>
          )}
        </Row>
      )}
      <SettingRow
        label={t('dontSync')}
        hint={t(link.skipped ? 'dontSyncOn' : 'dontSyncOff')}
        control={
          <Switch
            checked={link.skipped}
            disabled={busy !== null || link.pending}
            aria-label={t('dontSync')}
            onChange={(event: { currentTarget: HTMLInputElement }) => void act('skip', () => host.post('skip', { task: link.task, on: event.currentTarget.checked }), again)}
            data-testid="jira-dont-sync"
          />
        }
      />
      {reviewing && (
        <SyncReview
          task={link.task}
          onClose={() => setReviewing(false)}
          onSynced={() => {
            setReviewing(false);
            again();
          }}
        />
      )}
      {creating && (
        <CreateReview
          link={link}
          connections={connections}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            again();
          }}
        />
      )}
    </Stack>
  );
}

// ---- the create review ------------------------------------------------------------------

// One task's create as the person reviews it (Jira Push): the board it goes to, the issue type, each value sent, and a
// value for each field Jira requires that the task does not hold; Create once nothing stops it.
function CreateReview(props: { link: TaskLink; connections: string[]; onClose: () => void; onCreated: () => void }): JSX.Element {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const [connection, setConnection] = useState(props.link.connection ?? props.connections[0] ?? '');
  const [choices, setChoices] = useState<CreateChoices>({ fields: {} });
  const [plan, setPlan] = useState<CreatePlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let live = true;
    setError(null);
    setPlan(null);
    hostRef.current.post<CreatePlanView>('create-plan', { task: props.link.task, connection, options: choices }).then(
      (next) => {
        if (live) setPlan(next);
      },
      (cause) => {
        if (live) setError(reason(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [hostRef, props.link.task, connection, choices]);
  const create = async (): Promise<void> => {
    setCreating(true);
    try {
      const answer = await host.post<{ created: { key: string; differs: string[] } }>('create', { task: props.link.task, connection, options: choices });
      host.toast(t('createdTitle', { key: answer.created.key }), 'success', answer.created.differs.length > 0 ? t('createdDiffers', { fields: answer.created.differs.join(', ') }) : undefined);
      props.onCreated();
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
    } finally {
      setCreating(false);
    }
  };
  let body: JSX.Element;
  if (error) body = <Notice>{error}</Notice>;
  else if (!plan)
    body = (
      <Stack pad="sm">
        <SkeletonBar width="70%" />
        <SkeletonBar width="50%" />
      </Stack>
    );
  else
    body = (
      <Stack gap="sm">
        {plan.recovering && (
          <Text size="sm" tone="muted" block>
            {t('createRecovering')}
          </Text>
        )}
        {plan.type && (
          <Text size="sm" block>
            {t('createType', { type: plan.type })}
          </Text>
        )}
        {plan.parent && (
          <Text size="sm" block>
            {t('createParent', { key: plan.parent })}
          </Text>
        )}
        {plan.fields.map((field) => (
          <Text key={field.jira} size="sm" tone="muted" block>
            {`${field.jira}: ${field.value}`}
          </Text>
        ))}
        {plan.later.length > 0 && (
          <Text size="xs" tone="faint" block>
            {t('createLater', { fields: plan.later.join(', ') })}
          </Text>
        )}
        {plan.blockers.map((blocker) => (
          <Notice key={blocker.message}>
            <Stack gap="xs">
              <Text size="sm" block>
                {blocker.message}
              </Text>
              {blocker.ask ? (
                <BlockerAsk
                  ask={blocker.ask}
                  onChoose={(value) => {
                    if (blocker.ask!.kind === 'type') setChoices({ ...choices, type: value });
                    else setChoices({ ...choices, fields: { ...choices.fields, [blocker.ask!.field ?? '']: value } });
                  }}
                />
              ) : (
                <Text size="xs" tone="faint" block>
                  {blocker.fix}
                </Text>
              )}
            </Stack>
          </Notice>
        ))}
      </Stack>
    );
  return (
    <Modal
      size="lg"
      title={t('createTitle', { task: props.link.task })}
      onClose={props.onClose}
      foot={
        <Row justify="between">
          <Row>
            {choices.type ? (
              <Button size="sm" variant="quiet" onClick={() => setChoices({ ...choices, type: undefined })}>
                {t('ask_type')}
              </Button>
            ) : null}
          </Row>
          <Row>
            <Button variant="quiet" onClick={props.onClose}>
              {t('cancel')}
            </Button>
            <Button variant="primary" disabled={creating || plan === null || plan.blockers.length > 0} onClick={() => void create()} data-testid="jira-create">
              {t(creating ? 'creating' : 'create')}
            </Button>
          </Row>
        </Row>
      }
    >
      <Stack gap="sm">
        {props.connections.length > 1 && !props.link.pending && (
          <SettingRow
            label={t('createBoard')}
            control={
              <Select aria-label={t('createBoard')} value={connection} onChange={(event: { target: HTMLSelectElement }) => setConnection(event.target.value)}>
                {props.connections.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            }
          />
        )}
        <Card variant="home">{body}</Card>
      </Stack>
    </Modal>
  );
}

// ---- the settings page ------------------------------------------------------------------

function JiraSettings(): JSX.Element {
  const host = usePluginHost();
  const { state, setState } = useJiraState();
  const { busy, act } = useActions(host);
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
      <Boards state={state} busy={busy} act={act} take={take} onMap={(name) => host.navigate(mappingHref(host, name))} />
      <Options state={state} act={act} take={take} />
    </Stack>
  );
}

const mappingHref = (host: PluginHost, name: string): string => host.hrefs.page(`mapping/${encodeURIComponent(name)}`);

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
  // the site's sign-in in use here, from the environment, this root's pick, or the default
  const inUse = (site: string): SignInRow | undefined => props.state.sign_ins.find((row) => row.site === site);
  const choose = (row: HeldRow, global: boolean): void =>
    void props.act(`use:${row.site}/${row.email}`, () => host.post<{ state: State }>('use', { site: row.site, email: row.email, global }), props.take);
  const signOut = async (row: HeldRow): Promise<void> => {
    if (!(await host.dialog.confirm(t('signOutAsk', { email: row.email, site: row.site }), { title: t('signOutTitle'), ok: t('signOut'), danger: true }))) return;
    await props.act(`logout:${row.site}/${row.email}`, () => host.post<{ state: State }>('logout', { site: row.site, email: row.email }), props.take);
  };
  // what the kept accounts do not show: a sign-in the environment gives, one picked whose token is gone, and a site a
  // connection names with no account kept for it
  const keptFor = (row: SignInRow): boolean => props.state.held.some((held) => held.site === row.site && (row.email === null || held.email === row.email.toLowerCase()));
  const unheld = props.state.sign_ins.filter((row) => row.scope === 'environment' || !keptFor(row));
  const unheldHint = (row: SignInRow): string => {
    if (row.scope === 'environment') return t('fromEnvironment', { site: row.site });
    if (row.email) return t('tokenGone', { site: row.site });
    return t('nobodySignedIn', { site: row.site });
  };
  return (
    <Stack gap="xs">
      <SettingsHead>{t('account')}</SettingsHead>
      <Card variant="grouped">
        {unheld.map((row) => (
          <SettingRow
            key={`${row.site}:${row.scope ?? 'none'}`}
            label={row.email ?? row.site}
            hint={unheldHint(row)}
            badge={row.scope === 'environment' ? <Badge tone="ok">{t('inUseHere')}</Badge> : null}
          />
        ))}
        {props.state.held.map((row) => {
          const using = inUse(row.site);
          const here = using?.scope !== 'environment' && using?.email?.toLowerCase() === row.email;
          const key = `${row.site}/${row.email}`;
          let hint = t('keptOnly', { site: row.site });
          if (row.picked) hint = t('pickedHere', { site: row.site });
          else if (row.default) hint = t('defaultEverywhere', { site: row.site });
          return (
            <SettingRow
              key={key}
              data-testid={`jira-sign-in-${row.email}`}
              label={row.email}
              hint={hint}
              badge={
                <Row gap="xs">
                  {here ? <Badge tone="ok">{t('inUseHere')}</Badge> : null}
                  {row.default ? <Badge>{t('defaultBadge')}</Badge> : null}
                </Row>
              }
              control={
                <Row>
                  {!here && (
                    <Button disabled={props.busy !== null} onClick={() => choose(row, false)}>
                      {t('useHere')}
                    </Button>
                  )}
                  {!row.default && (
                    <Button disabled={props.busy !== null} onClick={() => choose(row, true)}>
                      {t('makeDefault')}
                    </Button>
                  )}
                  <Button variant="quiet" disabled={props.busy !== null} onClick={() => void signOut(row)}>
                    {t('signOut')}
                  </Button>
                </Row>
              }
            />
          );
        })}
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
              <Text size="xs" tone="faint" block>
                {t(global ? 'everyRootOn' : 'everyRootOff')}
              </Text>
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

// The mapping editor (Jira REQ12), a page of its own for a board: every value Jira holds beside the Backlog value it
// maps to, the held pair or a suggestion first, each changeable; fields per issue type, with a property made on the
// spot for a field none fits. While Jira is read, each stage of the read is shown as it starts. Leaving or reading Jira
// again with changes unsaved asks first.
function MappingPage(props: { name: string }): JSX.Element {
  const host = usePluginHost();
  const { t } = host;
  const [model, setModel] = useState<Model | null>(null);
  const [chosen, setChosen] = useState<Choice | null>(null);
  // the mapping as last read or saved, to tell what is unsaved
  const [saved, setSaved] = useState<Choice | null>(null);
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
          setSaved(next.chosen);
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
  const unsaved = chosen !== null && saved !== null && JSON.stringify(chosen) !== JSON.stringify(saved);
  const leaveUnsaved = async (): Promise<boolean> => !unsaved || host.dialog.confirm(t('unsavedAsk'), { title: t('unsavedTitle'), ok: t('discard'), danger: true });
  const back = async (): Promise<void> => {
    if (await leaveUnsaved()) host.navigate('/plugins/jira');
  };
  const readAgain = async (): Promise<void> => {
    if (await leaveUnsaved()) read(true);
  };

  const save = async (): Promise<void> => {
    if (!chosen) return;
    setSaving(true);
    try {
      const answer = await host.put<{ problems: Array<{ message: string }>; state: State }>('mapping', { name: props.name, mapping: chosen });
      setSaved(chosen);
      if (answer.problems.length > 0) host.toast(t('mappingProblems', { n: answer.problems.length }), 'error', answer.problems[0]!.message);
      else host.toast(t('mappingSaved'), 'success', props.name);
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
    } finally {
      setSaving(false);
    }
  };

  let body: JSX.Element;
  if (error) body = <Notice>{error}</Notice>;
  else if (!model || !chosen) body = <Reading stages={stages} />;
  else if (tab === 'fields') body = <Fields model={model} chosen={chosen} setChosen={setChosen} setModel={setModel} connection={props.name} />;
  else body = <Values tab={tab} model={model} chosen={chosen} setChosen={setChosen} />;
  return (
    <Page width="narrow" data-testid="jira-mapping">
      <PageHead sticky>
        <Stack gap="sm">
          <Row>
            <Button size="sm" variant="quiet" onClick={() => void back()}>
              {t('backToSettings')}
            </Button>
          </Row>
          <Row justify="between" align="start" wrap>
            <Stack gap="none">
              <PageTitle>{t('mappingTitle', { name: props.name })}</PageTitle>
              <PageText>
                {model ? t('readFrom', { date: new Date(model.read).toLocaleString() }) : t('readingBoard')}
                {unsaved ? ` · ${t('unsaved')}` : ''}
              </PageText>
            </Stack>
            <Row>
              <Button variant="quiet" disabled={!model} onClick={() => void readAgain()}>
                {t('readAgain')}
              </Button>
              <Button variant="primary" disabled={saving || !unsaved} onClick={() => void save()} data-testid="jira-save-mapping">
                {t(saving ? 'savingMapping' : 'saveMapping')}
              </Button>
            </Row>
          </Row>
          {model && (
            <Seg data-testid="jira-mapping-parts">
              {TABS.map((each) => (
                <SegItem key={each} selected={tab === each} aria-pressed={tab === each} onClick={() => setTab(each)}>
                  {t(`part_${each}`)}
                </SegItem>
              ))}
            </Seg>
          )}
        </Stack>
      </PageHead>
      <Stack gap="md">
        {model && (
          <Notice>
            <Row justify="between" wrap>
              <Text size="sm">{t('backlogFirst')}</Text>
              <Button size="sm" onClick={() => host.navigate('/plugins/backlog')}>
                {t('openBacklog')}
              </Button>
            </Row>
          </Notice>
        )}
        {body}
      </Stack>
    </Page>
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
  views: [
    { sector: 'primary', name: 'boards', title: 'Jira', icon: JiraIcon, render: () => <JiraView /> },
    // the open ticket's own panel, beside a task the Backlog shows
    {
      sector: 'auxiliary',
      name: 'ticket',
      title: 'Jira',
      icon: JiraIcon,
      render: () => <TicketView />,
      when: (open: { kind: string; plugin?: string }) => open.kind === 'page' && open.plugin === 'backlog',
    },
  ],
  pages: [{ path: 'mapping', render: (route: { segments: string[] }) => <MappingPage key={route.segments[0] ?? ''} name={decodeURIComponent(route.segments[0] ?? '')} /> }],
  settings: () => <JiraSettings />,
  settingsDrawn: ['connections', 'accounts', 'pull_attachments', 'add_people', 'auto_fetch'],
};
