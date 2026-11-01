#!/usr/bin/env node
// Build the spike into dist/: the sandboxed page and the offscreen
// document bundled with their packages, the kernel's worker bundled
// whole (the sandbox makes a blob of it), the rest copied.
//
//     node spike/extension-agent/build.mjs [--default-csp]
//
// `--default-csp` leaves the sandbox's CSP as Chrome's default, to see
// what the custom one is needed for.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const esbuild = createRequire(createRequire(join(root, "package.json")).resolve("vite"))("esbuild");
const out = join(here, "dist");

/** The CSP the sandbox gets: eval, workers and module imports from blobs, and esm.sh. */
export const SANDBOX_CSP = "sandbox allow-scripts; script-src 'self' 'unsafe-eval' blob: https://esm.sh; worker-src 'self' blob:; child-src 'self' blob:";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const common = { bundle: true, format: "esm", platform: "browser", target: "chrome120", absWorkingDir: root, logLevel: "warning", external: ["node:*", "worker_threads"] };
await esbuild.build({ ...common, entryPoints: [join(here, "src", "sandbox-entry.js")], outfile: join(out, "sandbox.js") });
await esbuild.build({ ...common, entryPoints: [join(here, "src", "offscreen-entry.js")], outfile: join(out, "offscreen.js") });
await esbuild.build({ ...common, entryPoints: [join(root, "node_modules", "@agex-ts", "world", "dist", "worker.js")], outfile: join(out, "worker.js") });
for (const f of ["background.js", "offscreen.html", "sandbox.html"]) cpSync(join(here, "src", f), join(out, f));
const manifest = JSON.parse(readFileSync(join(here, "src", "manifest.json"), "utf8"));
if (!process.argv.includes("--default-csp")) manifest.content_security_policy = { sandbox: SANDBOX_CSP };
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${out}${process.argv.includes("--default-csp") ? " (Chrome's default sandbox CSP)" : ""}`);
