// Auto sync (Jira Sync REQ19, REQ20): each person's, off by default, and run
// only where the app's server runs. A task edited here is synced a few
// seconds after its last save, and every task edited here once the app
// pushes, one sync at a time; anything a sync would stop on (a conflict, a
// status to choose, a loss to agree to) writes nothing and puts the task in
// Needs you, kept in the plugin's local folder until a sync of it succeeds.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Host } from 'eidosmd/plugin';
import type { JiraApi } from './index.ts';
import type { Blocker } from './sync.ts';

export interface Need {
  task: string;
  key: string;
  // what stops the sync, a line per field that stops it
  reason: string;
  at: string;
}

// the quiet after a task's last save before it is synced, so a run of edits is one sync
const SETTLE_MS = 5_000;

const needsFile = (workspace: string): string => path.join(workspace, 'local', 'needs.json');

export function readNeeds(workspace: string): Need[] {
  const file = needsFile(workspace);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Need[]).filter((need) => typeof need?.task === 'string') : [];
  } catch {
    return [];
  }
}

// A task put in Needs you, or taken off it with null.
export function setNeed(workspace: string, task: string, need: Need | null): void {
  const held = readNeeds(workspace).filter((entry) => entry.task !== task);
  const next = need ? [...held, need] : held;
  if (next.length === held.length && !need && !existsSync(needsFile(workspace))) return;
  mkdirSync(path.dirname(needsFile(workspace)), { recursive: true });
  writeFileSync(needsFile(workspace), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

// A field as a person names it: section:acceptance-criteria is Acceptance criteria.
const sideName = (side: string): string => {
  const bare = side.replace(/^(section|property):/, '').replace(/[-_]/g, ' ');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
};

// What stops a sync, in a line: a conflict and a loss by what they are, anything else as the sync says it.
function blockerLine(blocker: Blocker): string {
  const name = blocker.side ? sideName(blocker.side) : null;
  if (name && (blocker.code === 'conflict' || blocker.code === 'unrecorded')) return `${name}: changed in Jira and here`;
  if (name && blocker.code === 'loss') return `${name}: writing it would drop what Jira holds that markdown cannot`;
  return blocker.message;
}

export function startAutoSync(host: Host, api: JiraApi): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let queue: Promise<void> = Promise.resolve();
  // the tasks edited here since their last pull or sync, read from the root alone, by task with their issue's key
  const edited = (): Map<string, string> => new Map(api.syncStatus().flatMap((status) => status.edited.map((entry) => [entry.task, entry.key] as [string, string])));
  // named once: a task already waiting for the same reason is not announced again at each save
  const needs = (task: string, key: string, reason: string): void => {
    const known = readNeeds(host.workspace).some((need) => need.task === task && need.reason === reason);
    setNeed(host.workspace, task, { task, key, reason, at: new Date().toISOString() });
    if (!known) host.emit('needs', { task, key, reason });
    host.emit('changed', { task });
  };
  // the plan read first, so what stops the sync is named field by field in a line, and nothing is written while it does
  const syncOne = async (task: string, key: string): Promise<void> => {
    try {
      const plan = await api.syncPlan(task, {});
      if (plan.blockers.length > 0) return needs(task, key, plan.blockers.map(blockerLine).join('; '));
      await api.sync(task, {});
    } catch (cause) {
      needs(task, key, (cause instanceof Error ? cause.message : String(cause)).replace(/^\S+ is not synced: /, ''));
    }
  };
  const run = (tasks: Array<[string, string]>): void => {
    queue = queue.then(async () => {
      for (const [task, key] of tasks) await syncOne(task, key);
    });
  };

  host.files.on('saved', (paths) => {
    if (host.settings().get<boolean>('auto_sync_on_save') !== true) return;
    const now = edited();
    for (const file of paths) {
      const link = api.taskAt(file);
      if (!link?.key || link.skipped || !now.has(link.task)) continue;
      const task = link.task;
      const key = link.key;
      clearTimeout(timers.get(task));
      timers.set(
        task,
        setTimeout(() => {
          timers.delete(task);
          // edited still: a pull or a sync since the save may have settled it
          if (edited().has(task)) run([[task, key]]);
        }, SETTLE_MS),
      );
    }
  });

  // a push the app makes, heard through Git's API when Git is on (Git Source Control REQ8)
  const git = host.plugin<{ onPush?: (listener: (target: string | null) => void) => () => void }>('git');
  const offPush = git?.onPush?.(() => {
    if (host.settings().get<boolean>('auto_sync_on_push') === true) run([...edited()]);
  });

  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    offPush?.();
  };
}
