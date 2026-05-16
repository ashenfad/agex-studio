/**
 * Tests for the shared bytes utilities.
 *
 * `formatBytes` is a pure formatting helper — boundary-case coverage
 * is sufficient. `bytesToBase64` correctness gets tested through a
 * round-trip vs `atob`; the chunked-apply path is exercised
 * explicitly with an array larger than the 0x8000 chunk size.
 */

import { describe, expect, it } from "vitest";

import { bytesToBase64, formatBytes } from "./bytes.js";

describe("formatBytes", () => {
    it("uses bytes below 1 KB", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(847)).toBe("847 B");
        expect(formatBytes(1023)).toBe("1023 B");
    });

    it("uses KB between 1 KB and 1 MB", () => {
        expect(formatBytes(1024)).toBe("1.0 KB");
        expect(formatBytes(12345)).toBe("12.1 KB");
        expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
    });

    it("uses MB at 1 MB and above", () => {
        expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
        expect(formatBytes(47 * 1024 * 1024 + 300_000)).toBe("47.3 MB");
    });
});

describe("bytesToBase64", () => {
    it("matches the canonical base64 for an empty array", () => {
        expect(bytesToBase64(new Uint8Array())).toBe("");
    });

    it("matches the canonical base64 for ASCII bytes", () => {
        const bytes = new TextEncoder().encode("hello world");
        expect(bytesToBase64(bytes)).toBe("aGVsbG8gd29ybGQ=");
    });

    it("round-trips correctly through atob", () => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8]);
        const b64 = bytesToBase64(bytes);
        const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });

    it("handles input larger than the chunk size without exhausting the stack", () => {
        // 0x8000 is the per-chunk size; go several chunks over to
        // verify the loop actually iterates rather than blowing up.
        const SIZE = 0x8000 * 3 + 17;
        const bytes = new Uint8Array(SIZE);
        for (let i = 0; i < SIZE; i++) bytes[i] = i & 0xff;
        const b64 = bytesToBase64(bytes);
        const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        expect(decoded.length).toBe(SIZE);
        // Spot-check a few positions to confirm the chunking didn't
        // drop bytes at the boundaries.
        expect(decoded[0]).toBe(0);
        expect(decoded[0x8000 - 1]).toBe(0xff);
        expect(decoded[0x8000]).toBe(0);
        expect(decoded[SIZE - 1]).toBe((SIZE - 1) & 0xff);
    });
});
