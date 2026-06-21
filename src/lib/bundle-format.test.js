/**
 * Tests for the pure bundle-format helpers. The gist-target logic
 * (defaultPublishTarget / gistFallbackId) carries the real correctness
 * weight — the rules that decide whether a publish PATCHes the existing
 * gist or POSTs a fresh one, and whether a surprising new URL gets
 * explained as a 404-fallback — so it gets the most cases.
 */

import { describe, expect, it } from "vitest";

import {
    bundleFilename,
    defaultPublishTarget,
    gistFallbackId,
    phaseLabel,
    publishSizeHint,
    shapeSize,
} from "./bundle-format.js";

describe("phaseLabel", () => {
    it("names known phases", () => {
        expect(phaseLabel("walking")).toBe("Walking history");
        expect(phaseLabel("packing-blobs")).toBe("Packing blobs");
        expect(phaseLabel("finalizing")).toBe("Finalizing");
    });

    it("passes unknown phases through verbatim", () => {
        expect(phaseLabel("mystery")).toBe("mystery");
    });
});

describe("shapeSize", () => {
    const estimates = { full: 100, flat: 50, flatDownsampled: 30, flatStripped: 10 };

    it("maps each shape key to its profile field", () => {
        expect(shapeSize(estimates, "full")).toBe(100);
        expect(shapeSize(estimates, "flat")).toBe(50);
        expect(shapeSize(estimates, "flat-downsample")).toBe(30);
        expect(shapeSize(estimates, "flat-strip")).toBe(10);
    });

    it("returns null with no estimates or an uncovered shape", () => {
        expect(shapeSize(null, "full")).toBeNull();
        expect(shapeSize(estimates, "nonsense")).toBeNull();
    });

    it("clamps negatives to 0", () => {
        expect(shapeSize({ full: -5 }, "full")).toBe(0);
    });
});

describe("publishSizeHint", () => {
    it("is empty until estimates load", () => {
        expect(publishSizeHint(null, "full")).toBe("");
    });

    it("formats a ' · ~<size>' suffix when known", () => {
        expect(publishSizeHint({ full: 1024 }, "full")).toBe(" · ~1.0 KB");
    });
});

describe("bundleFilename", () => {
    it("slugifies a label and appends .agex", () => {
        expect(bundleFilename("My Cool Session!")).toBe("my-cool-session.agex");
    });

    it("trims leading/trailing separators", () => {
        expect(bundleFilename("  --Hello--  ")).toBe("hello.agex");
    });

    it("falls back to 'session' when nothing slug-able remains", () => {
        expect(bundleFilename("???")).toBe("session.agex");
        expect(bundleFilename("")).toBe("session.agex");
        expect(bundleFilename(null)).toBe("session.agex");
    });
});

describe("defaultPublishTarget", () => {
    it("defaults to 'new' with no prior gist", () => {
        expect(defaultPublishTarget(null)).toBe("new");
    });

    it("updates an earned mapping", () => {
        expect(defaultPublishTarget({ gistId: "g1", inherited: false })).toBe("existing");
    });

    it("forks off a fresh gist for an inherited mapping", () => {
        expect(defaultPublishTarget({ gistId: "g1", inherited: true })).toBe("new");
    });
});

describe("gistFallbackId", () => {
    const prior = { gistId: "old123" };

    it("reports the prior id when an update landed on a different gist", () => {
        expect(gistFallbackId(true, prior, "new456")).toBe("old123");
    });

    it("is empty when the update hit the same gist", () => {
        expect(gistFallbackId(true, prior, "old123")).toBe("");
    });

    it("is empty for an intentional new-gist publish (never mislabeled)", () => {
        expect(gistFallbackId(false, prior, "new456")).toBe("");
    });

    it("is empty with no prior gist", () => {
        expect(gistFallbackId(true, null, "new456")).toBe("");
    });
});
