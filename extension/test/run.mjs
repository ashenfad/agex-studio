#!/usr/bin/env node
/**
 * The extension's end-to-end tests, as `pnpm extension:test` runs them:
 * every build made once (dev, store, site), then the test files four at a
 * time, told the builds are made (`EXTENSION_BUILT`) so none rebuilds
 * one another is loading. In Node rather than the shell, so it runs the
 * same on Windows; arguments after it go to `node --test`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, "..", "build.mjs");
for (const flags of [["--dev"], [], ["--site"]]) execFileSync(process.execPath, [build, ...flags], { stdio: "inherit" });

const files = readdirSync(here).filter((f) => f.endsWith(".e2e.mjs")).map((f) => join(here, f));
const run = spawnSync(process.execPath, ["--test", "--test-concurrency=4", "--test-timeout=300000", ...process.argv.slice(2), ...files], {
    stdio: "inherit",
    env: { ...process.env, EXTENSION_BUILT: "1" },
});
process.exit(run.status ?? 1);
