export const TargetStatus = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  STOPPED: "STOPPED",
} as const;

export type TargetStatus = (typeof TargetStatus)[keyof typeof TargetStatus];
