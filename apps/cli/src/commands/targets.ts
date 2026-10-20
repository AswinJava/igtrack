import { display, emit, flagString, isJson, relativeTime, table, UsageError, type ParsedArgs } from "../output.js";
import { createContext } from "../context.js";
import { opTargetAdd, opTargetList, opTargetRemove, opTargetSetStatus } from "../tools.js";

export const TARGETS_HELP = `igtrack targets <subcommand>

  list                          Tracked accounts with status, mode and last observation
  add <username> [--name N] [--tags a,b] [--observed]
                                Start tracking an account (idempotent per user)
  pause <id|username>           Stop scheduling scans (history is preserved)
  resume <id|username>          Return the target to ACTIVE
  rm <id|username> --yes        Delete the target and its observations

Targets are always scoped to the resolved owner user. "rm" proceeds through the
retention boundary and is irreversible, so it requires --yes.

--observed tracks ANOTHER public account through the documented Business
Discovery route (mode DISCOVERY). The route is probed once first; if it answers
UNAVAILABLE the target is refused and the platform's reason (or the flag that
unlocks it) is printed, because a target that cannot be scanned is worse than no
target. Such a target runs only DISCOVERY_SCAN: profile fields plus a bounded,
non-pageable recent-media preview. Read it back with \`igtrack dossier\`.`;

export async function runTargets(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const json = isJson(args.flags);
  const rest = args.positionals.slice(1);

  if (sub === "list") {
    const ctx = await createContext();
    try {
      const targets = await opTargetList(ctx);
      const human =
        targets.length === 0
          ? "No targets. Add one with `igtrack targets add <username>`."
          : table(
              ["id", "username", "mode", "status", "followers", "following", "last observed", "source"],
              targets.map((t) => [
                t.id,
                `@${t.username}`,
                t.observationMode,
                t.status,
                t.followerCount === null ? "unavailable" : String(t.followerCount),
                t.followingCount === null ? "unavailable" : String(t.followingCount),
                t.lastObserved === null ? "never" : relativeTime(t.lastObserved),
                display(t.snapshotSourceId),
              ]),
            );
      emit({ json, meta: ctx.meta, data: targets, human });
      return 0;
    } finally {
      await ctx.close();
    }
  }

  if (sub === "add") {
    const username = rest[0];
    if (username === undefined) {
      throw new UsageError(
        "Usage: igtrack targets add <username> [--name N] [--tags a,b] [--observed]",
      );
    }
    const observed = args.flags["observed"] === true;
    const tags = (flagString(args.flags, "tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const ctx = await createContext();
    try {
      const result = await opTargetAdd(ctx, {
        username,
        localName: flagString(args.flags, "name"),
        tags,
        observed,
      });
      const human = [
        result.created
          ? `Tracking @${result.username} (${result.id}) in ${result.observationMode} mode.`
          : `@${result.username} was already tracked (${result.id}).`,
        result.probe === null
          ? ""
          : `Probe    ${result.probe.status} · observed ${display(result.probe.observedAt)} · ${display(result.probe.note)}`,
        result.note,
        result.unobservable === undefined
          ? ""
          : `WARNING  ${result.unobservable}`,
      ]
        .filter((line) => line !== "")
        .join("\n");
      emit({ json, meta: ctx.meta, data: result, human });
      return 0;
    } finally {
      await ctx.close();
    }
  }

  if (sub === "pause" || sub === "resume") {
    const reference = rest[0];
    if (reference === undefined) throw new UsageError(`Usage: igtrack targets ${sub} <id|username>`);
    const ctx = await createContext();
    try {
      const result = await opTargetSetStatus(ctx, {
        target: reference,
        status: sub === "pause" ? "PAUSED" : "ACTIVE",
      });
      const human = `@${result.username}: ${result.previous} → ${result.status}`;
      emit({ json, meta: ctx.meta, data: result, human });
      return 0;
    } finally {
      await ctx.close();
    }
  }

  if (sub === "rm" || sub === "remove" || sub === "delete") {
    const reference = rest[0];
    if (reference === undefined) throw new UsageError("Usage: igtrack targets rm <id|username> --yes");
    if (args.flags["yes"] !== true) {
      throw new UsageError(
        "Refusing to delete without --yes. This removes the target and every observation, snapshot and evidence row retained for it.",
      );
    }
    const ctx = await createContext();
    try {
      const result = await opTargetRemove(ctx, reference);
      const human = `Deleted @${result.username} (${result.id}) and its observations.`;
      emit({ json, meta: ctx.meta, data: result, human });
      return 0;
    } finally {
      await ctx.close();
    }
  }

  throw new UsageError(`Unknown targets subcommand "${sub}".\n\n${TARGETS_HELP}`);
}
