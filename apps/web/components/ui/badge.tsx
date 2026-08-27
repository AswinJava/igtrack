import { capabilityToneClasses, presentCapability, type CapabilityState } from "@/lib/capability";

export function Badge({
  children,
  tone = "muted",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "success" | "warning" | "danger" | "muted" | "info";
  className?: string;
}) {
  const tones: Record<string, string> = {
    success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    danger: "bg-red-500/10 text-red-400 border-red-500/20",
    muted: "bg-zinc-800 text-zinc-400 border-zinc-700",
    info: "bg-sky-500/10 text-sky-400 border-sky-500/20",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-wide ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function CapabilityBadge({ state }: { state: CapabilityState }) {
  const p = presentCapability(state);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${capabilityToneClasses(p.tone)}`}
      title={p.description}
    >
      <span aria-hidden>{p.icon}</span> {p.label}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const tone =
    confidence === "HIGH" ? "success" : confidence === "MEDIUM" ? "info" : confidence === "LOW" ? "warning" : "muted";
  return <Badge tone={tone as any}>{confidence}</Badge>;
}

export function CategoryBadge({ category }: { category: string }) {
  const tone =
    category === "OBSERVED" ? "info" : category === "DERIVED" ? "warning" : category === "INFERRED" ? "muted" : "danger";
  const label = category === "OBSERVED" ? "Observed" : category === "DERIVED" ? "Derived" : category === "INFERRED" ? "Inferred" : "Unavailable";
  return <Badge tone={tone as any}>{label}</Badge>;
}
