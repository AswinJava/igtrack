export const TargetStatus = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  STOPPED: "STOPPED",
} as const;

export type TargetStatus = (typeof TargetStatus)[keyof typeof TargetStatus];

export const TargetLifecycleTransitions: Record<
  TargetStatus,
  readonly TargetStatus[]
> = {
  ACTIVE: [TargetStatus.PAUSED, TargetStatus.STOPPED],
  PAUSED: [TargetStatus.ACTIVE, TargetStatus.STOPPED],
  STOPPED: [],
};

export function isLegalTargetTransition(
  from: TargetStatus,
  to: TargetStatus,
): boolean {
  if (from === to) return false;
  return TargetLifecycleTransitions[from].includes(to);
}
