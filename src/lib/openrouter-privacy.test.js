import { afterEach, describe, expect, it } from "vitest";
import { routerPost } from "./openrouter-api.js";
import { updateSettings } from "./settings.js";

/** A fetch that keeps each body it was sent. */
function stub() {
    /** @type {any[]} */
    const sent = [];
    const fetchImpl = /** @type {typeof fetch} */ (
        async (/** @type {any} */ _url, /** @type {any} */ init) => {
            sent.push(JSON.parse(init.body));
            return new Response("{}");
        }
    );
    return { fetchImpl, sent };
}

afterEach(() => updateSettings({ routerDenyTraining: false, routerZdr: false }));

describe("the privacy settings on every OpenRouter request", () => {
    it("narrow web's and media's requests too, beside a call's own provider options", async () => {
        updateSettings({ accessMode: "openrouter", routerKey: "sk-test", routerDenyTraining: true, routerZdr: true });
        const { fetchImpl, sent } = stub();
        await routerPost({ label: "web.search", path: "/chat/completions", body: { model: "m" }, timeout: 5, fetchImpl });
        // media.speech sends options of its own under provider
        const speech = { model: "tts", provider: { options: { "google-ai-studio": { speech_metadata: { style: "warm" } } } } };
        await routerPost({ label: "media.speech", path: "/audio/speech", body: speech, timeout: 5, fetchImpl });
        expect(sent[0].provider).toEqual({ data_collection: "deny", zdr: true });
        expect(sent[1].provider).toEqual({ options: speech.provider.options, data_collection: "deny", zdr: true });
        // the caller's body isn't changed
        expect(speech.provider).not.toHaveProperty("zdr");
    });

    it("leave a request as it was when neither is set", async () => {
        updateSettings({ accessMode: "openrouter", routerKey: "sk-test" });
        const { fetchImpl, sent } = stub();
        await routerPost({ label: "media.image", path: "/images", body: { model: "m" }, timeout: 5, fetchImpl });
        expect(sent[0]).toEqual({ model: "m" });
    });
});
