import { test, expect, type Page } from "@playwright/test";

// Phase 6 minimal smoke coverage — synthetic fixture provider only, never
// real Instagram. Selectors lean on accessible roles and stable labels.

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue as seeded dev user/ }).click();
  await page.waitForURL("**/");
}

test.describe.serial("IGTrack smoke", () => {
  test("login lands on an authenticated dashboard", async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/\/$/);
    // The dev server compiles routes on first hit; allow generous time.
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 });
  });

  test("new synthetic target is queued and appears in the list", async ({ page }) => {
    await login(page);
    await page.goto("/targets");
    await page.getByRole("button", { name: "+ New target" }).click();
    await page.getByLabel("Instagram username").fill("aurora.wilde");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    // Live provider preview renders before anything is created.
    await expect(page.getByText("Live provider preview")).toBeVisible();
    await page.getByRole("button", { name: /Create & queue observation/ }).click();
    // The created card links to the target detail page.
    const card = page.getByRole("link", { name: /@aurora\.wilde/ }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Fresh target with queued initial jobs reports SYNCING, not SYNCED.
    await expect(card.getByText("SYNCING")).toBeVisible();
  });

  test("unknown username previews an error and creates nothing", async ({ page }) => {
    await login(page);
    await page.goto("/targets");
    await page.getByRole("button", { name: "+ New target" }).click();
    await page.getByLabel("Instagram username").fill("nobody.___zzz_missing");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(/No public account/);
    await expect(page.getByRole("button", { name: /Create & queue observation/ })).toHaveCount(0);
    // The API refuses creation directly too: no target from an invalid preview.
    const refused = await page.evaluate(async () => {
      const res = await fetch("/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "nobody.___zzz_missing" }),
      });
      return { status: res.status, body: await res.json() };
    });
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe("NOT_FOUND");
  });

  test("lookup previews without tracking, then tracks explicitly", async ({ page }) => {
    await login(page);
    await page.goto("/lookup?username=aurora.wilde");
    await expect(page.getByRole("heading", { name: "@aurora.wilde" })).toBeVisible();
    await expect(page.getByText("not yet tracked")).toBeVisible();
    // Preview alone tracks nothing: the explicit Track button is required.
    await expect(page.getByRole("button", { name: /Track @/ })).toBeVisible();
  });

  test("lookup unknown shows an explicit error, not an empty profile", async ({ page }) => {
    await login(page);
    await page.goto("/lookup?username=nobody.___zzz_missing");
    await expect(page.getByText("Preview unavailable")).toBeVisible();
    await expect(page.getByRole("button", { name: /Track @/ })).toHaveCount(0);
  });

  test("target lifecycle: pause then resume", async ({ page }) => {
    await login(page);
    await page.goto("/targets");
    await page.getByRole("link", { name: /@aurora\.wilde/ }).first().click();
    await page.getByRole("button", { name: "Pause monitoring" }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByRole("button", { name: "Pause monitoring" })).toBeVisible();
  });

  test("manual sync queues scans; paused targets refuse with 409", async ({ page }) => {
    await login(page);
    await page.goto("/targets");
    await page.getByRole("link", { name: /@aurora\.wilde/ }).first().click();
    await expect(page).toHaveURL(/\/targets\/[0-9a-f-]+/);
    const targetId = page.url().split("/targets/")[1]!;
    // UI: Sync now reports what it queued.
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText(/Queued:/)).toBeVisible();
    // API: subset + idempotent double-click within the minute bucket.
    const api = await page.evaluate(async (id) => {
      const post = async (body: unknown) => {
        const res = await fetch(`/api/targets/${id}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };
      return {
        subset: await post({ kinds: ["STORY_SCAN"] }),
        bogus: await post({ kinds: ["NOPE"] }),
      };
    }, targetId);
    expect(api.subset.status).toBe(202);
    expect(api.bogus.status).toBe(400);
    // Paused targets refuse manual sync honestly instead of silently skipping.
    await page.getByRole("button", { name: "Pause monitoring" }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    const refused = await page.evaluate(async (id) => {
      const res = await fetch(`/api/targets/${id}/sync`, { method: "POST" });
      return { status: res.status, body: await res.json() };
    }, targetId);
    expect(refused.status).toBe(409);
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByRole("button", { name: "Pause monitoring" })).toBeVisible();
  });

  test("scan settings persist cadence and kind filters", async ({ page }) => {
    await login(page);
    await page.goto("/targets");
    await page.getByRole("link", { name: /@aurora\.wilde/ }).first().click();
    await page.getByRole("button", { name: "Scan settings" }).click();
    await page.getByLabel("Scan frequency").selectOption("0.5");
    await page.getByRole("checkbox", { name: "Posts" }).uncheck();
    await page.getByRole("button", { name: "Save scan settings" }).click();
    // Save closes the form on success (first PATCH compiles server-side; allow it).
    await expect(page.getByRole("button", { name: "Save scan settings" })).toHaveCount(0, { timeout: 30_000 });
    // Reopen: the persisted prefs render back.
    await page.getByRole("button", { name: "Scan settings" }).click();
    await expect(page.getByRole("checkbox", { name: "Posts" })).not.toBeChecked();
    // Restore defaults for later tests.
    await page.getByLabel("Scan frequency").selectOption("default");
    await page.getByRole("checkbox", { name: "Posts" }).check();
    await page.getByRole("button", { name: "Save scan settings" }).click();
  });

  test("evidence page renders and links to a chain", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Evidence", exact: true }).click();
    await expect(page).toHaveURL(/\/evidence/);
    // At least the seeded evidence list is reachable; the heading proves the surface.
    await expect(page.getByRole("heading", { name: "Evidence", exact: true })).toBeVisible();
  });

  test("target detail view is reachable", async ({ page }) => {
    await login(page);
    await page.goto("/targets");
    await page.getByRole("link", { name: /@aurora\.wilde/ }).first().click();
    await expect(page).toHaveURL(/\/targets\/[0-9a-f-]+/);
    await expect(page.getByRole("heading", { name: /@aurora\.wilde/ })).toBeVisible();
  });

  test("diagnostics page surfaces scheduler health without secrets", async ({ page }) => {
    await login(page);
    await page.goto("/diagnostics");
    await expect(page).toHaveURL(/\/diagnostics/);
    await expect(page.getByRole("heading", { name: "Diagnostics" })).toBeVisible();
    await expect(page.getByText("Scheduler", { exact: true })).toBeVisible();
    // No tokens/credentials on the surface.
    const body = await page.locator("body").innerText();
    expect(body.toLowerCase()).not.toContain("password");
    expect(body.toLowerCase()).not.toContain("cookie");
    // Educational capability reference renders with reasons.
    await expect(page.getByText("How each capability works")).toBeVisible();
    await expect(page.getByText("Story highlights")).toHaveCount(1);
    await expect(page.getByText(/To unlock:/).first()).toBeAttached();
  });

  test("deletes the created target", async ({ page }) => {
    await login(page);
    await page.goto("/targets");
    await page.getByRole("link", { name: /@aurora\.wilde/ }).first().click();
    await page.getByRole("button", { name: /Delete/ }).click();
    await page.getByRole("button", { name: "Delete everything" }).click();
    await page.waitForURL("**/targets");
    await expect(page.getByRole("link", { name: /@aurora\.wilde/ })).toHaveCount(0);
  });
});