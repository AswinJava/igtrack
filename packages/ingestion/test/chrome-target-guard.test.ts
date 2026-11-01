import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChromeTargetRejectedError,
  ChromeUnavailableError,
  chromeUnavailableMessage,
  dumpDom,
  emptyDomReason,
  findChrome,
} from "../src/public/chrome.js";

// ---------------------------------------------------------------------------
// The browser is a local process that receives an argument list.
//
// Two properties are worth pinning here, because both fail quietly: an
// operator-supplied executable path must be a browser and not merely a file,
// and a target URL must be a page rather than something Chrome reads as one of
// its own flags. No test in this file launches a browser: every refusal happens
// before a process exists. The empty-DOM block reads the stderr of a run that
// already happened; it does not launch a browser either.
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

  it("answers the two missing-browser causes with two different fixes", () => {
    // One sentence for two causes sends someone to a fix they do not need: the
    // operator who set --chrome to a wrong path does not have to install Chrome,
    // and the machine with no browser at all has nothing to point at.
    const wrongPath = chromeUnavailableMessage("C:\\Program Files\\Notepad\\notepad.exe");
    expect(wrongPath).toContain("C:\\Program Files\\Notepad\\notepad.exe");
    expect(wrongPath).toContain("Point --chrome");
    expect(wrongPath).not.toContain("Install Google Chrome");
    expect(wrongPath).toContain("No request was made.");

    const noneInstalled = chromeUnavailableMessage();
    expect(noneInstalled).toContain("Install Google Chrome");
    expect(noneInstalled).toContain("IGTRACK_CHROME_PATH");
    expect(noneInstalled).toContain("No request was made.");

    // Both sentences are the same refusal when the caller passes blanks.
    expect(chromeUnavailableMessage("   ")).toBe(noneInstalled);
  });
});

describe("the reason behind an empty DOM", () => {
  it("keeps Chrome's own page-load failure, because the operator has to know which fix applies", () => {
    // Recorded on a machine whose DNS had stopped answering. "Chrome returned
    // no HTML document" alone reads like an empty profile; the code says the
    // page was never resolved, which is a network fix.
    const stderr =
      "[12624:5144:1101/152358.428:ERROR:chrome\\browser\\extensions\\external_registry_loader_win.cc:147] Missing value path for key Software\\Google\\Chrome\\Extensions\\dngcpimnedloihjnnfngkgjoidhnaolf.\n" +
      "[12624:5144:1101/152358.900:ERROR:components\\headless\\command_handler\\headless_command_handler.cc:403] Page load failed: net::ERR_NAME_NOT_RESOLVED\n";
    const reason = emptyDomReason(stderr);
    expect(reason).toContain("net::ERR_NAME_NOT_RESOLVED");
    expect(reason).toContain("transport failure");
    expect(reason).not.toContain("external_registry_loader");
    expect(reason).not.toContain("Missing value path");
  });

  it("falls back to the last real line when Chrome says nothing about a page load", () => {
    const reason = emptyDomReason("[1234:1:ERROR:some/file.cc:12] GPU process exited unexpectedly\n");
    expect(reason).toContain("GPU process exited unexpectedly");
  });

  it("still refuses when Chrome prints nothing at all", () => {
    const reason = emptyDomReason("   \n  ");
    expect(reason).toContain("no HTML document");
    expect(reason).toContain("transport failure");
  });

  it("cuts a pathological line instead of printing a wall of text", () => {
    const reason = emptyDomReason(`Page load failed: ${"x".repeat(5000)}`);
    expect(reason.length).toBeLessThan(400);
  });
});
