export type CapabilityState = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" | "ERROR";

export interface CapabilityPresentation {
  label: string;
  description: string;
  tone: "success" | "warning" | "muted" | "danger";
  icon: string;
}

const MAP: Record<CapabilityState, CapabilityPresentation> = {
  AVAILABLE: {
    label: "Available",
    description: "This source provided the requested information with meaningful coverage.",
    tone: "success",
    icon: "●",
  },
  PARTIAL: {
    label: "Partial",
    description: "Some information was observable but coverage is incomplete.",
    tone: "warning",
    icon: "◐",
  },
  UNAVAILABLE: {
    label: "Unavailable",
    description: "This source does not provide the capability.",
    tone: "muted",
    icon: "○",
  },
  ERROR: {
    label: "Error",
    description: "The system attempted retrieval but failed.",
    tone: "danger",
    icon: "✕",
  },
};

export function presentCapability(state: CapabilityState): CapabilityPresentation {
  return MAP[state] ?? MAP.UNAVAILABLE;
}

export function capabilityToneClasses(tone: CapabilityPresentation["tone"]): string {
  switch (tone) {
    case "success":
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
    case "warning":
      return "bg-amber-500/10 text-amber-400 border-amber-500/20";
    case "danger":
      return "bg-red-500/10 text-red-400 border-red-500/20";
    case "muted":
      return "bg-zinc-800 text-zinc-400 border-zinc-700";
  }
}
