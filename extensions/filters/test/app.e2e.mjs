// The extension's page: the studio's model settings, saved in the
// extension's own storage, and a turn on the model they name, through
// the offscreen document, with a service of the test's own.
//
//     pnpm filters:test

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { build } from "../build.mjs";
import { launch } from "./harness.mjs";
import { modelServer } from "./model-server.mjs";

describe("the extension's page", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {Awaited<ReturnType<typeof modelServer>>} */
    let model;
    /** @type {import("playwright").Page} */
    let page;
    before(async () => {
        model = await modelServer();
        browser = await launch(await build("dev"));
        page = await browser.context.newPage();
        await page.goto(`chrome-extension://${browser.id}/app/app.html`);
    });
    after(async () => {
        await browser?.close();
        await model?.close();
    });

    it("shows the studio's model settings, with nothing saved yet", async () => {
        await page.getByText("Agex Site Filters", { exact: true }).waitFor();
        await page.getByText("No model yet").waitFor();
        assert.equal(await page.getByRole("button", { name: "Save" }).isDisabled(), true);
    });

    it("saves an endpoint of the person's own, and a turn runs on it, tool call and all", async () => {
        await page.getByText("My own endpoint").click();
        await page.getByPlaceholder("http://localhost:3456").fill(model.url);
        await page.getByLabel("Shape").selectOption("openai");
        await page.getByPlaceholder("the endpoint's name for it").fill("mock");
        await page.getByRole("button", { name: "Save" }).click();
        await page.getByText("No model yet").waitFor({ state: "detached" });
        const out = await page.evaluate(() => chrome.runtime.sendMessage({ op: "turn", site: "example.com", prompt: "What's 6 * 7? Use code." }));
        assert.equal(out.error, undefined, out.error);
        assert.equal(out.value.status, "completed");
        assert.deepEqual(out.value.tools.map((t) => [t.name, t.isError, t.result.trim()]), [["run_ts", false, "42"]]);
        assert.equal(out.value.text, "The code printed 42.");
        assert.equal(model.requests.length, 2);
        assert.equal(model.requests[0].model, "mock");
    });

    it("shows what each of a site's runs did: asked, its calls and their results, and its last words", async () => {
        await page.reload();
        await page.getByRole("button", { name: /example\.com/ }).click();
        await page.getByText("What's 6 * 7? Use code.").waitFor();
        await page.getByText("The code printed 42.").waitFor();
        await page.getByText("What it did").click();
        await page.getByText("console.log(6 * 7)").waitFor();
        assert.equal(await page.locator(".step pre.result").first().textContent(), "42");
        assert.match(await page.locator(".run .hint").first().textContent() ?? "", /completed · 1 call/);
    });
});
