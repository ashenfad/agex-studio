// Spike: starts Chromium (Chrome for Testing) as a plain process with the
// extension loaded, and none of an automation tool's throttling flags,
// opens the driver, and waits for its results.
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const here = new URL(".", import.meta.url).pathname
const ext = join(here, "extension")
const id = (await readFile(join(ext, "id.txt"), "utf8")).trim()
const chrome = process.env.CHROME ??
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
const only = process.argv[2] ? `&only=${process.argv[2]}` : ""
const profile = await mkdtemp(join(tmpdir(), "agex-spike-"))
const results = join(here, "results")
await rm(join(results, "done.json"), { force: true })

const server = spawn(process.execPath, [join(here, "server.mjs")], { stdio: "inherit" })
await new Promise((r) => setTimeout(r, 500))
const browser = spawn(chrome, [
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
    "--window-size=1100,800",
    `http://localhost:4173/?ext=${id}${only}`,
], { stdio: "ignore" })

const deadline = Date.now() + Number(process.env.DEADLINE ?? 300) * 1000
while (Date.now() < deadline) {
    if (await stat(join(results, "done.json")).catch(() => null)) break
    await new Promise((r) => setTimeout(r, 1000))
}
browser.kill(); server.kill()
await rm(profile, { recursive: true, force: true })
console.log(Date.now() < deadline ? "finished" : "timed out")
