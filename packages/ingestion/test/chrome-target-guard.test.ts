import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChromeTargetRejectedError,
  ChromeUnavailableError,
  dumpDom,
  findChrome,
} from "../src/public/chrome.js";

// ---------------------------------------------------------------------------
// The browser is a local process that receives an argument list.
//
// Two properties are worth pinning here, because both fail quietly: an
// operator-supplied executable path must be a browser and not merely a file,
// and a target URL must be a page rather than something Chrome reads as one of
// its own flags. No test in this file launches a browser: every refusal happens
// before a process exists.
// ---------------------------------------------------------------------------

let dir = "";
const browserPath = () => join(dir, "chrome.exe");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "igtrack-chrome-guard-"));
  writeFileSync(browserPath(), "not a real browser, only a name\n");
  writeFileSync(join(dir, "notepad.exe"), "definitely not a browser\n");
  mkdirSync(join(dir, "chrome"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("chrome executable and target guards", () => {
  it("refuses an explicit path that is a real file but not a browser", () => {
    // process.execPath always exists on this machine; it is Node, not Chrome.
    expect(findChrome(process.execPath)).toBeUndefined();
    expect(findChrome(join(dir, "notepad.exe"))).toBeUndefined();
  });

  it("refuses a directory that happens to be named like a browser", () => {
    expect(findChrome(join(dir, "chrome"))).toBeUndefined();
  });

  it("accepts an explicit path that names a browser file", () => {
    expect(findChrome(browserPath())).toBe(browserPath());
  });

  it("says the path was refused, rather than that no browser is installed", async () => {
    const err = await dumpDom("https://www.instagram.com/some.account/", {
      executablePath: join(dir, "notepad.exe"),
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ChromeUnavailableError);
    expect((err as Error).message).toContain("not a Chrome/Chromium/Edge executable");
  });

  it("refuses a target that Chrome would read as one of its own flags", async () => {
    const err = await dumpDom("--user-data-dir=C:\\Windows", {
      executablePath: browserPath(),
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ChromeTargetRejectedError);
    expect((err as Error).message).toContain("would be read as a Chrome flag");
  });

  it("refuses a non-http scheme and an empty target", async () => {
    for (const target of ["file:///etc/passwd", "", "   ", "javascript:alert(1)", "not a url"]) {
      const err = await dumpDom(target, { executablePath: browserPath() }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, `target ${JSON.stringify(target)}`).toBeInstanceOf(ChromeTargetRejectedError);
    }
  });
});
