export interface FollowDiff<T = string> {
  added: T[];
  removed: T[];
  unchangedCount: number;
}

export function diffFollowSets(previous: string[], next: string[]): FollowDiff {
  const prevSet = new Set(previous);
  const nextSet = new Set(next);
  const added: string[] = [];
  const removed: string[] = [];
  let unchangedCount = 0;

  for (const id of nextSet) {
    if (prevSet.has(id)) unchangedCount += 1;
    else added.push(id);
  }
  for (const id of prevSet) {
    if (!nextSet.has(id)) removed.push(id);
  }

  added.sort();
  removed.sort();
  return { added, removed, unchangedCount };
}
