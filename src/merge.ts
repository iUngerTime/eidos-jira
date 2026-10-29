// A section changed on both sides, merged as a git merge conflict is (Jira
// Sync REQ18): the lines both hold, in order, and between them each place the
// two differ, a conflict the person settles by keeping Jira's lines, the
// task's, or both. Only a fingerprint of the last synced value is kept, so
// nothing here knows which side deleted a line: every difference is a
// conflict, never settled in silence.

export type Segment = { kind: 'shared'; lines: string[] } | { kind: 'conflict'; jira: string[]; here: string[] };
export type Pick = 'jira' | 'eidos' | 'both';

// The two texts as runs of shared lines and the conflicts between them.
export function segmentsOf(jira: string, here: string): Segment[] {
  const left = jira === '' ? [] : jira.split('\n');
  const right = here === '' ? [] : here.split('\n');
  // the longest common run of lines, from the end, so the walk below can choose at each step
  const longest: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1)
    for (let j = right.length - 1; j >= 0; j -= 1) longest[i]![j] = left[i] === right[j] ? longest[i + 1]![j + 1]! + 1 : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
  const out: Segment[] = [];
  const shared = (line: string): void => {
    const last = out.at(-1);
    if (last?.kind === 'shared') last.lines.push(line);
    else out.push({ kind: 'shared', lines: [line] });
  };
  const differ = (side: 'jira' | 'here', line: string): void => {
    let last = out.at(-1);
    if (last?.kind !== 'conflict') {
      last = { kind: 'conflict', jira: [], here: [] };
      out.push(last);
    }
    last[side].push(line);
  };
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      shared(left[i]!);
      i += 1;
      j += 1;
    } else if (j >= right.length || (i < left.length && longest[i + 1]![j]! >= longest[i]![j + 1]!)) {
      differ('jira', left[i]!);
      i += 1;
    } else {
      differ('here', right[j]!);
      j += 1;
    }
  }
  return out;
}

// The merged text, each conflict settled by its pick (both: Jira's lines, then the task's).
export function mergeText(segments: Segment[], pick: (conflict: number) => Pick): string {
  let conflict = -1;
  const lines = segments.flatMap((segment) => {
    if (segment.kind === 'shared') return segment.lines;
    conflict += 1;
    const chosen = pick(conflict);
    if (chosen === 'jira') return segment.jira;
    if (chosen === 'eidos') return segment.here;
    return [...segment.jira, ...segment.here];
  });
  return lines.join('\n').trim();
}

// Both sides of every conflict kept, as `--take <section>=both` asks.
export const mergeBoth = (jira: string, here: string): string => mergeText(segmentsOf(jira, here), () => 'both');
