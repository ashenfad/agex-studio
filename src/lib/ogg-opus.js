/**
 * Speech as Opus in an Ogg file (RFC 7845): the browser's own encoder
 * (WebCodecs `AudioEncoder`), wrapped in the pages every browser plays.
 * About a tenth the size of the same speech as 16-bit WAV.
 */

/** Opus's granule clock: positions count 48kHz samples, whatever the
 *  input's rate. */
const OPUS_RATE = 48_000;
/** libopus's lookahead, which a decoder skips: 6.5ms. */
export const PRE_SKIP = 312;
/** Plenty for speech: Opus is transparent for a voice well below it. */
const SPEECH_BITRATE = 32_000;
/** How many packets a page holds at most: about a second of 20ms ones. */
const PACKETS_PER_PAGE = 50;

/** Whether this browser can encode Opus at `rate` and `channels`.
 *  @param {number} rate @param {number} channels */
export async function canEncodeOpus(rate, channels) {
    if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return false;
    try {
        const { supported } = await AudioEncoder.isConfigSupported(opusConfig(rate, channels));
        return supported === true;
    } catch {
        return false;
    }
}

/** @param {number} rate @param {number} channels */
const opusConfig = (rate, channels) => ({ codec: "opus", sampleRate: rate, numberOfChannels: channels, bitrate: SPEECH_BITRATE });

/**
 * 16-bit little-endian PCM as an Ogg Opus file, by the browser's encoder
 * (check `canEncodeOpus` first).
 *
 * @param {Uint8Array} pcm @param {number} rate @param {number} channels
 */
export async function encodeOpus(pcm, rate, channels) {
    /** @type {{ data: Uint8Array, samples: number }[]} */
    const packets = [];
    /** @type {unknown} */
    let failure = null;
    const encoder = new AudioEncoder({
        output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            packets.push({ data, samples: Math.round(((chunk.duration ?? 20_000) * OPUS_RATE) / 1e6) });
        },
        error: (e) => {
            failure = e;
        },
    });
    encoder.configure(opusConfig(rate, channels));
    const frames = Math.floor(pcm.length / (2 * channels));
    // AudioData copies its source: hand it the samples, aligned
    const samples = new Int16Array(frames * channels);
    new Uint8Array(samples.buffer).set(pcm.subarray(0, samples.byteLength));
    const audio = new AudioData({ format: "s16", sampleRate: rate, numberOfFrames: frames, numberOfChannels: channels, timestamp: 0, data: samples });
    encoder.encode(audio);
    audio.close();
    await encoder.flush();
    encoder.close();
    if (failure !== null) throw failure;
    return oggOpus(packets, { channels, rate, frames });
}

/**
 * Opus packets in an Ogg stream: the `OpusHead` and `OpusTags` pages,
 * then the audio, its last page's granule position trimming the
 * encoder's padding so the file lasts exactly `frames` at `rate`.
 *
 * @param {readonly { data: Uint8Array, samples: number }[]} packets each with its length in 48kHz samples
 * @param {{ channels: number, rate: number, frames: number, serial?: number }} spec
 */
export function oggOpus(packets, { channels, rate, frames, serial = 0x61676578 }) {
    const head = new Uint8Array(19);
    const hv = new DataView(head.buffer);
    head.set(ascii("OpusHead"), 0);
    head[8] = 1; // version
    head[9] = channels;
    hv.setUint16(10, PRE_SKIP, true);
    hv.setUint32(12, rate, true); // the input's rate, for information
    hv.setInt16(16, 0, true); // output gain
    head[18] = 0; // channel mapping family: mono or stereo
    const vendor = ascii("agex studio");
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    const tv = new DataView(tags.buffer);
    tags.set(ascii("OpusTags"), 0);
    tv.setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    tv.setUint32(12 + vendor.length, 0, true); // no comments

    /** @type {Uint8Array[]} */
    const pages = [];
    let sequence = 0;
    const page = (/** @type {Uint8Array[]} */ body, /** @type {bigint} */ granule, /** @type {number} */ flags) =>
        pages.push(oggPage(body, { granule, flags, serial, sequence: sequence++ }));
    page([head], 0n, 0x02);
    page([tags], 0n, 0);

    const end = BigInt(PRE_SKIP + Math.round((frames * OPUS_RATE) / rate));
    let granule = 0n;
    for (let i = 0; i < packets.length; i += PACKETS_PER_PAGE) {
        const group = packets.slice(i, i + PACKETS_PER_PAGE);
        for (const p of group) granule += BigInt(p.samples);
        const last = i + PACKETS_PER_PAGE >= packets.length;
        page(group.map((p) => p.data), last && end < granule ? end : granule, last ? 0x04 : 0);
    }
    if (packets.length === 0) page([], end, 0x04);
    return concat(pages);
}

/**
 * One Ogg page holding whole packets.
 *
 * @param {readonly Uint8Array[]} packets
 * @param {{ granule: bigint, flags: number, serial: number, sequence: number }} spec
 */
export function oggPage(packets, { granule, flags, serial, sequence }) {
    /** @type {number[]} */
    const lacing = [];
    for (const p of packets) {
        for (let n = p.length; ; n -= 255) {
            lacing.push(Math.min(n, 255));
            if (n < 255) break;
        }
    }
    if (lacing.length > 255) throw new Error("ogg: too many segments for one page");
    const size = 27 + lacing.length + packets.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    out.set(ascii("OggS"), 0);
    out[4] = 0; // version
    out[5] = flags;
    view.setBigInt64(6, granule, true);
    view.setUint32(14, serial, true);
    view.setUint32(18, sequence, true);
    // the checksum (22) is taken with its own field zero
    out[26] = lacing.length;
    out.set(lacing, 27);
    let at = 27 + lacing.length;
    for (const p of packets) {
        out.set(p, at);
        at += p.length;
    }
    view.setUint32(22, oggCrc(out), true);
    return out;
}

/** @type {Uint32Array | null} */
let crcTable = null;

/** Ogg's CRC-32: polynomial 0x04c11db7, unreflected, from zero.
 *  @param {Uint8Array} bytes */
export function oggCrc(bytes) {
    if (crcTable === null) {
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let r = i << 24;
            for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
            crcTable[i] = r >>> 0;
        }
    }
    let crc = 0;
    for (const b of bytes) crc = ((crc << 8) ^ /** @type {number} */ (crcTable[((crc >>> 24) ^ b) & 0xff])) >>> 0;
    return crc;
}

/** @param {string} s */
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** @param {readonly Uint8Array[]} parts */
function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}
