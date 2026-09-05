"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const primary = [
  { href: "/", label: "Dashboard", icon: "◧" },
  { href: "/targets", label: "Tracked Accounts", icon: "◎" },
  { href: "/activity", label: "Activity", icon: "◷" },
  { href: "/relationships", label: "Relationships", icon: "⬡" },
];

const secondary = [
  { href: "/lookup", label: "Lookup", icon: "⌕" },
  { href: "/evidence", label: "Evidence", icon: "⬔" },
  { href: "/diagnostics", label: "Diagnostics", icon: "⬢" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

function NavItem({ href, label, icon, active }: { href: string; label: string; icon: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
      }`}
    >
      <span className="w-5 text-center text-xs" aria-hidden>
        {icon}
      </span>
      {label}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  // Provider pill reflects the live /api/healthz probe — never hardcoded, so a
  // graph deployment stops claiming synthetic data.
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/healthz", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: unknown) => {
        if (cancelled) return;
        const name =
          typeof json === "object" && json !== null && "provider" in json
            ? String((json as { provider: unknown }).provider)
            : null;
        setProvider(name);
      })
      .catch(() => {
        if (!cancelled) setProvider(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const pill =
    provider === null ? null : provider === "graph" ? "LIVE" : "SYNTHETIC";

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 lg:flex">
      <div className="flex h-14 items-center gap-2 border-b border-zinc-800 px-5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500 text-xs font-bold text-zinc-950">
          I
        </div>
        <span className="text-sm font-semibold tracking-tight">IGTrack</span>
        {pill !== null && (
          <span className="ml-auto rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium tracking-widest text-amber-400">
            {pill}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <p className="mb-2 px-3 text-[11px] font-semibold tracking-widest text-zinc-500">PRIMARY</p>
        <nav className="space-y-1">
          {primary.map((item) => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </nav>

        <p className="mb-2 mt-6 px-3 text-[11px] font-semibold tracking-widest text-zinc-500">SECONDARY</p>
        <nav className="space-y-1">
          {secondary.map((item) => (
            <NavItem key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </nav>
      </div>

      <div className="border-t border-zinc-800 p-4">
        <p className="text-xs font-medium text-zinc-400">Evidence-first</p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          Claims link to provenance. Inferred intelligence is never presented as fact.
        </p>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  return (
    <nav className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-950 px-2 py-2 lg:hidden">
      {[...primary, ...secondary].map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium ${
            isActive(item.href) ? "bg-zinc-800 text-zinc-100" : "text-zinc-500"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
