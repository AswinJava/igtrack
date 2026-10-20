// ---------------------------------------------------------------------------
// A per-test copy of the packaged fixture set, rebound to a per-test account.
//
// A fixture set speaks about exactly ONE account, and the worker's identity
// gate refuses a scan of any other target rather than answering it with the
// set's bytes (that refusal is the fix for synthetic data being filed under
// a real account's record).
//
// A test that needs its own target therefore needs its own set: the same
// payload, a different subject. The platform id is rebound too, because one
// platform id may never be bound to two accounts — that is the identity
// invariant the account repository enforces.
// ---------------------------------------------------------------------------

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceKind } from "@igtrack/core";
import { FixtureProvider } from "@igtrack/ingestion";
import type { ExecutionSource } from "../src/index.js";

let idCounter = 9_800_000_000;

export interface FixtureSetOptions {
  /** Rewrite a file after the copy — used to make a deliberately broken set. */
  mutate?: (dir: string) => Promise<void>;
}

export interface FixtureSet {
  fixturesDir: string;
  account: string;
  igId: string;
  source: ExecutionSource;
}

export async function fixtureSetForAccount(
  account: string,
  options: FixtureSetOptions = {},
): Promise<FixtureSet> {
  const packaged = join(process.cwd(), "packages", "ingestion", "fixtures", "v1");
  const dir = await mkdtemp(join(tmpdir(), "igtrack-fixture-set-"));
  await cp(packaged, dir, { recursive: true });

  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
    target_username: string;
  };
  manifest.target_username = account;
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  idCounter += 1;
  const igId = String(idCounter);
  const profile = JSON.parse(await readFile(join(dir, "profile.json"), "utf8")) as {
    profile: { id: string; username: string; profile_pic_url: string };
  };
  profile.profile.id = igId;
  profile.profile.username = account;
  profile.profile.profile_pic_url = `https://cdn.igtrack.test/avatars/${account}.jpg`;
  await writeFile(join(dir, "profile.json"), JSON.stringify(profile, null, 2));

  if (options.mutate !== undefined) {
    await options.mutate(dir);
  }

  const provider = new FixtureProvider({ fixturesDir: dir });
  return {
    fixturesDir: dir,
    account,
    igId,
    source: {
      provider,
      source: {
        id: provider.sourceId,
        kind: SourceKind.FIXTURE,
        name: `fixture set for ${account}`,
      },
    },
  };
}
