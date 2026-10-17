# Running and deploying IGTrack

Three ways to run it, in increasing order of effort. **None of them costs
money, and none of them requires an account on anyone else's server** — a
hosting provider and a database are the only things you might choose to use, and
you can run both on your own machine instead.

---

## 1. Local, everything on your machine (recommended first)

```bash
pnpm install
cp .env.example .env
docker compose up -d              # Postgres 16 on localhost:5432
pnpm igtrack setup                # migrate (+ synthetic demo on an empty database)
pnpm igtrack status
```

Then drive it by hand or by agent:

```bash
pnpm igtrack scans run
pnpm igtrack work --max 25        # foreground worker: observes, then exits
pnpm igtrack activity

pnpm worker                       # optional long-running worker daemon
```

Postgres is the only required external service. If you have no database URL
configured, `pnpm igtrack setup --local` uses the Compose database and records it
in `.env`.

## 2. One host, containers (a VPS, a home server, a NAS)

[docker-compose.prod.yml](../docker-compose.prod.yml) runs Postgres and the
worker together:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

- `Dockerfile.worker` runs the job runner daemon (scheduler + poll loop).
- Agents on the host talk to the deployment through `igtrack` /
  `igtrack mcp` — there is no network-facing app container, by design.

### Backup and restore

```bash
./scripts/backup.sh                      # pg_dump + SHA-256 checksum, 14-day retention
./scripts/restore.sh <dump-file>         # restores into a fresh database
```

The scripts prefer the database container (no host `pg_dump` needed) and fall
back to a host client. Verify a restore periodically; an unverified backup is a
hope, not a plan.

## 3. Cron-driven worker (no daemon)

If you prefer scheduled one-shots over a daemon, run the ephemeral worker from
cron or any scheduler:

```bash
IGTRACK_WORKER_ONCE=1 pnpm --filter @igtrack/monitoring start
```

It drains up to `IGTRACK_JOB_MAX_ITER` jobs (default 25) and exits. The queue's
leases and idempotency keys make overlapping runs safe.

If you use a managed Postgres, put `?sslmode=require` in the URL — the client
enables TLS when it sees it. Never commit the URL: use your platform's secret
store. Provider credentials (`IGTRACK_GRAPH_*`) belong there too.

## Production checklist

- [ ] Database reachable over TLS, with a URL that is not in git.
- [ ] Migrations applied deliberately (`pnpm --filter @igtrack/database db:migrate`).
- [ ] `pnpm igtrack doctor` reports what you expect — and **read the findings**.
      A degraded source row is a real signal, not noise.
- [ ] Decide the provider honestly: `fixture` (synthetic, labelled, safe forever)
      or `graph` (live, owned Business/Creator account only). There is no third
      option, on purpose.
- [ ] Backups verified by an actual restore.
- [ ] One worker process, or several — the queue is safe either way.

## Operating notes

- **The worker is where observation happens.** `igtrack scans run` only queues.
  A deployment with no worker produces no observations and will look empty —
  and `igtrack doctor` will say so rather than inventing numbers.
- **Story freshness matters.** Stories live 24 hours, so the default story cadence
  is 30 minutes; a missed poll is a permanent gap in that day's history. Observed
  story lifetimes (first seen / last seen / sighting count) are recorded precisely
  because the window is short.
- **Alerts are not built in.** An agent (or a cron job calling `igtrack activity
  --since`) is the notification path. That is deliberate: no email provider, no
  webhook service, no hosted notifier.
- **Scaling down is fine.** Pause a target instead of deleting it; history stays
  intact and scheduling stops.
