import { describe, expect, it } from "vitest";
import { PRE_SKIP, oggCrc, oggOpus, oggPage } from "./ogg-opus.js";

/** The pages of an Ogg stream, read back. @param {Uint8Array} bytes */
function pages(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    for (let at = 0; at < bytes.length; ) {
        expect(new TextDecoder().decode(bytes.subarray(at, at + 4))).toBe("OggS");
        const segments = /** @type {number} */ (bytes[at + 26]);
        const lacing = [...bytes.subarray(at + 27, at + 27 + segments)];
        const size = 27 + segments + lacing.reduce((n, l) => n + l, 0);
        const page = bytes.slice(at, at + size);
        const crc = view.getUint32(at + 22, true);
        page.set([0, 0, 0, 0], 22);
        out.push({
            flags: bytes[at + 5],
            granule: view.getBigInt64(at + 6, true),
            sequence: view.getUint32(at + 18, true),
            lacing,
            body: bytes.subarray(at + 27 + segments, at + size),
            crcOk: oggCrc(page) === crc,
        });
        at += size;
    }
    return out;
}

describe("Ogg Opus", () => {
    it("checksums as Ogg does", () => {
        // CRC-32/POSIX's check value, before its final inversion
        expect(oggCrc(new TextEncoder().encode("123456789"))).toBe(0x89a1897f);
    });

    it("laces a packet in 255-byte segments, a short one ending it", () => {
        const page = oggPage([new Uint8Array(255), new Uint8Array(3)], { granule: 0n, flags: 0, serial: 1, sequence: 0 });
        expect(pages(page)[0]?.lacing).toEqual([255, 0, 3]);
    });

    it("heads the stream, then the audio, its end trimmed to the input's length", () => {
        const packets = Array.from({ length: 51 }, (_, i) => ({ data: new Uint8Array([i, i]), samples: 960 }));
        const out = pages(oggOpus(packets, { channels: 1, rate: 24_000, frames: 24_000 }));
        expect(out.map((p) => p.flags)).toEqual([0x02, 0, 0, 0x04]);
        expect(out.map((p) => p.sequence)).toEqual([0, 1, 2, 3]);
        expect(out.every((p) => p.crcOk)).toBe(true);
        const head = /** @type {Uint8Array} */ (out[0]?.body);
        expect(new TextDecoder().decode(head.subarray(0, 8))).toBe("OpusHead");
        expect(head[9]).toBe(1);
        expect(new DataView(head.buffer, head.byteOffset).getUint16(10, true)).toBe(PRE_SKIP);
        expect(new TextDecoder().decode(out[1]?.body.subarray(0, 8))).toBe("OpusTags");
        // 50 packets on a page: the first second, then the last one
        expect(out.slice(2).map((p) => p.lacing.length)).toEqual([50, 1]);
        expect(out[2]?.granule).toBe(48_000n);
        // a second at 24kHz is 48000 at Opus's clock, past the skipped lookahead
        expect(out[3]?.granule).toBe(BigInt(PRE_SKIP + 48_000));
    });

    it("pages a long stream about a second at a time", () => {
        const packets = Array.from({ length: 120 }, () => ({ data: new Uint8Array(80), samples: 960 }));
        const out = pages(oggOpus(packets, { channels: 1, rate: 24_000, frames: 57_360 }));
        expect(out.map((p) => p.lacing.length)).toEqual([1, 1, 50, 50, 20]);
        expect(out.map((p) => p.granule)).toEqual([0n, 0n, 48_000n, 96_000n, BigInt(PRE_SKIP + 114_720)]);
    });

    it("never ends past what its packets hold", () => {
        const packets = [{ data: new Uint8Array(80), samples: 960 }];
        const out = pages(oggOpus(packets, { channels: 1, rate: 48_000, frames: 960 }));
        expect(out.at(-1)?.granule).toBe(960n);
    });
});
