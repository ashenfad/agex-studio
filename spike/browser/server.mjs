// Spike: serves the driver (the studio's stand-in) on 4173, the fixture
// site on 4174, and keeps what the driver posts under results/.
import { createServer } from "node:http"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { extname, join } from "node:path"

const here = new URL(".", import.meta.url).pathname
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" }
const out = process.env.RESULTS ?? join(here, "results")
await mkdir(out, { recursive: true })

function serve(port, root, onPost) {
    createServer(async (req, res) => {
        const path = new URL(req.url, "http://x").pathname
        if (req.method === "POST" && onPost) {
            let body = ""
            for await (const c of req) body += c
            await onPost(JSON.parse(body))
            return res.end("ok")
        }
        try {
            const file = join(root, path === "/" ? "index.html" : path)
            res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream")
            res.end(await readFile(file))
        } catch { res.statusCode = 404; res.end() }
    }).listen(port, "127.0.0.1")
}

serve(4173, join(here, "driver"), async ({ name, data, log }) => {
    if (log !== undefined) return console.log(log)
    await writeFile(join(out, `${name}.json`), JSON.stringify(data, null, 2))
    console.log(`result: ${name}`)
})
serve(4174, join(here, "fixtures"))
console.log("driver http://localhost:4173  site http://localhost:4174")
