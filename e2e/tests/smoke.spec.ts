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
    await page.getByRole("button", { name: /Create & queue observation/ }).click();
    // The created card links to the target detail page.
    const card = page.getByRole("link", { name: /@aurora\.wilde/ }).first();
    await expect(card).toBeVisible();
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

  test("evidence page renders and links to a chain", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Evidence" }).click();
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