import { test, expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDb } from "../../packages/database/src/index.js";

// Release-gate journeys: relationship detection on seeded history,
// cross-user authorization failure, and real worker-drain synchronization.
// Serial, single worker, isolated e2e database. Never live Instagram.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const E2E_DB =
  process.env.IGTRACK_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_e2e";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as seeded dev user/ }).click();
  await page.waitForURL("**/");
}

async function intruderTargetId(): Promise<string> {
  const handle = createDb({ url: E2E_DB, max: 1 });
  try {
    const rows = (await handle.sql`
      SELECT t.id FROM targets t
      JOIN users u ON u.id = t.user_id
      WHERE u.email = 'intruder@igtrack.local'
      LIMIT 1
    `) as Array<{ id: string }>;
    if (!rows[0]) throw new Error("e2e setup: intruder target missing");
    return rows[0].id;
  } finally {
    await handle.close();
  }
}

test.describe.serial("IGTrack release gate", () => {
  test("journey 8: seeded history shows a newly observed relationship", async ({ page }) => {
    await login(page);
    await page.goto("/targets");
    await page.getByRole("link", { name: /@target_a/ }).first().click();
    // Cold dev-server route compile can take a while on first navigation.
    await expect(page).toHaveURL(/\/targets\/[0-9a-f-]+/, { timeout: 30_000 });
    // Seeded FOLLOWING history: person_gamma arrived, person_beta left.
    await page.getByRole("link", { name: "following" }).click();
    await expect(page.getByText("No longer observed following")).toBeVisible();
    await expect(page.getByText("person_beta", { exact: false }).first()).toBeVisible();
  });

  test("journey 13: cross-user target access fails as not found", async ({ page }) => {
    const otherId = await intruderTargetId();
    await login(page);
    await page.goto(`/targets/${otherId}`);
    // Ownership boundary: another tenant's target renders the same
    // not-found surface as a missing id (no existence oracle).
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
    // And it never leaks into the dev user's list.
    await page.goto("/targets");
    await expect(page.getByRole("link", { name: "@intruder_target" })).toHaveCount(0);
  });

  test("journey 4/5/6/7/14: worker drain syncs a fresh target end to end", async ({ page }) => {
    test.setTimeout(420_000);
    await login(page);
    await page.goto("/targets");
    await page.getByRole("button", { name: "+ New target" }).click();
    await page.getByLabel("Instagram username").fill("aurora.wilde");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByText("Live provider preview")).toBeVisible();
    await page.getByRole("button", { name: /Create & queue observation/ }).click();
    const card = page.getByRole("link", { name: /@aurora\.wilde/ }).first();
    await expect(card).toBeVisible();

    // Drain the queue with the real worker binary against the isolated e2e
    // database (fixture provider only), stopping as soon as aurora.wilde has
    // a profile snapshot, stories, and a follower snapshot. Bounded so a
    // stuck queue fails loudly instead of hanging the suite.
    const synced = async (): Promise<boolean> => {
      const handle = createDb({ url: E2E_DB, max: 1 });
      try {
        const rows = (await handle.sql`
          SELECT
            (SELECT count(*)::int FROM profile_snapshots ps
              JOIN ig_accounts ia ON ia.id = ps.ig_account_id
              WHERE ia.username = 'aurora.wilde') AS profiles,
            (SELECT count(*)::int FROM stories s
              JOIN ig_accounts ia ON ia.id = s.ig_account_id
              WHERE ia.username = 'aurora.wilde') AS stories,
            (SELECT count(*)::int FROM follow_snapshots fs
              JOIN targets t ON t.id = fs.target_id
              JOIN ig_accounts ia ON ia.id = t.ig_account_id
              WHERE ia.username = 'aurora.wilde') AS follows
        `) as Array<{ profiles: number; stories: number; follows: number }>;
        const r = rows[0];
        return !!r && r.profiles > 0 && r.stories > 0 && r.follows > 0;
      } finally {
        await handle.close();
      }
    };
    let done = false;
    for (let i = 0; i < 20 && !done; i += 1) {
      const run = spawnSync("pnpm", ["--filter", "@igtrack/monitoring", "run-once"], {
        cwd: REPO_ROOT,
        shell: true,
        timeout: 120_000,
        encoding: "utf8",
        env: {
          ...process.env,
          IGTRACK_DATABASE_URL: E2E_DB,
          IGTRACK_PROVIDER: "fixture",
        },
      });
      if (run.status !== 0) {
        throw new Error(`worker run-once failed (iter ${i}): ${(run.stderr ?? "").slice(-2000)}`);
      }
      console.log(`worker iter ${i}: ${(run.stdout ?? "").trim().split("\n").slice(-3).join(" | ")}`);
      done = await synced();
    }
    expect(done).toBe(true);

    await card.click();
    await expect(page).toHaveURL(/\/targets\/[0-9a-f-]+/);
    // Initial sync populated real observations: counts, stories, followers.
    await expect(page.getByText("followers", { exact: false }).first()).toBeVisible();
    await page.getByRole("link", { name: "stories" }).click();
    await expect(page.getByText("story-", { exact: false }).first()).toBeVisible();
    await page.getByRole("link", { name: "followers" }).click();
    await expect(page.getByText("Completeness", { exact: false })).toBeVisible();

    // Every observation is source-labeled: the list card carries the same
    // derived fixture badge as the detail header.
    await page.goto("/targets");
    const syncedCard = page.getByRole("link", { name: /@aurora\.wilde/ }).first();
    await expect(syncedCard.getByText("SYNTHETIC SOURCE")).toBeVisible();

    // Cleanup so later runs start clean.
    await page.goto("/targets");
    await page.getByRole("link", { name: /@aurora\.wilde/ }).first().click();
    await page.getByRole("button", { name: /Delete/ }).click();
    await page.getByRole("button", { name: "Delete everything" }).click();
    await page.waitForURL("**/targets");
  });
});
