/*
 * The video as a file: app/export.js. Copy it beside the page; the
 * reference page's Export button calls it. It runs in the viewer's
 * browser, from the page itself, so a published video can be exported
 * by whoever watches it.
 *
 * HOW. It steps window.__player through every frame, draws #root to a
 * canvas (html-to-image, the same drawing test_app's screenshots use),
 * and encodes the frames with the browser's VideoEncoder. The sound is
 * every <audio> clip in #root, mixed offline at its data-start with its
 * data-duration, data-volume, data-fade-in and data-fade-out, then
 * encoded with the AudioEncoder. MP4 (H.264 and AAC) where the browser
 * can encode those, else WebM (VP9 and Opus).
 *
 * TIME. Drawing a 1920x1080 frame takes about 50ms, so a minute of video
 * at 30fps takes about a minute and a half. The tab has to stay visible
 * meanwhile: a hidden one is throttled.
 *
 * WHAT IT DRAWS is what a screenshot of #root shows: so the checks that
 * pass test_app pass here. A <video> inside the stage is not drawn, nor
 * an image from another site that doesn't allow it (CORS).
 *
 *   const file = await exportVideo({ onProgress: (f) => (label.textContent = `${Math.round(f * 100)}%`) });
 *   download(file);
 *
 * Options: fps (30), from and to (seconds: a part of the video, for a
 * quick check), format ('mp4' or 'webm', to choose rather than fall
 * back), signal (an AbortSignal, to cancel). Returns a File.
 */

const LIBS = {
  htmlToImage: 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm',
  mp4: 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/+esm',
  webm: 'https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/+esm',
};
const RATE = 48000;
const CHANNELS = 2;

/** The codecs this browser can encode for the stage's size, by format. */
async function pick(width, height, fps, wanted) {
  const video = async (codec) =>
    (await VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps, bitrate: 8e6 }).catch(() => ({}))).supported === true;
  const audio = async (codec) =>
    (await AudioEncoder.isConfigSupported({ codec, sampleRate: RATE, numberOfChannels: CHANNELS, bitrate: 128000 }).catch(() => ({}))).supported === true;
  const formats = [
    { format: 'mp4', videos: [['avc1.640028', 'avc'], ['avc1.640033', 'avc']], audios: [['mp4a.40.2', 'aac'], ['opus', 'opus']] },
    { format: 'webm', videos: [['vp09.00.40.08', 'V_VP9'], ['vp8', 'V_VP8']], audios: [['opus', 'A_OPUS']] },
  ].filter((f) => !wanted || f.format === wanted);
  for (const f of formats) {
    let v = null, a = null;
    for (const c of f.videos) if (await video(c[0])) { v = c; break; }
    for (const c of f.audios) if (await audio(c[0])) { a = c; break; }
    if (v && a) return { format: f.format, video: v, audio: a };
  }
  throw new Error('this browser can encode neither MP4 (H.264) nor WebM (VP9): export in Chrome, Edge or Safari');
}

/** Every audio clip in the stage, mixed as the runtime plays them. */
async function mixSound(root, from, to) {
  const ctx = new OfflineAudioContext(CHANNELS, Math.max(1, Math.ceil((to - from) * RATE)), RATE);
  for (const clip of root.querySelectorAll('audio[data-start]')) {
    const buffer = await ctx.decodeAudioData(await (await fetch(clip.currentSrc || clip.src)).arrayBuffer());
    const start = Number(clip.dataset.start) || 0;
    const length = Math.min(Number(clip.dataset.duration) || buffer.duration, buffer.duration);
    const volume = clip.dataset.volume === undefined ? 1 : Number(clip.dataset.volume);
    const fadeIn = Number(clip.dataset.fadeIn) || 0;
    const fadeOut = Number(clip.dataset.fadeOut) || 0;
    if (start + length <= from || start >= to) continue;
    // the clip's timeline, moved so the export starts at 0
    const at = (t) => Math.max(0, start + t - from);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(fadeIn ? 0 : volume, at(0));
    if (fadeIn) gain.gain.linearRampToValueAtTime(volume, at(fadeIn));
    if (fadeOut) {
      gain.gain.setValueAtTime(volume, at(length - fadeOut));
      gain.gain.linearRampToValueAtTime(0, at(length));
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain).connect(ctx.destination);
    const skip = Math.max(0, from - start);
    source.start(at(skip), skip, length - skip);
  }
  return ctx.startRendering();
}

export async function exportVideo({ fps = 30, from = 0, to, format, signal, onProgress = () => {} } = {}) {
  const player = window.__player;
  if (!player) throw new Error('the HyperFrames runtime is not ready');
  const root = document.getElementById('root');
  const width = Number(root.dataset.width) || 1920;
  const height = Number(root.dataset.height) || 1080;
  const end = Math.min(to ?? player.getDuration(), player.getDuration());
  const [{ toCanvas, getFontEmbedCSS }, codecs] = await Promise.all([import(LIBS.htmlToImage), pick(width, height, fps, format)]);
  const { Muxer, ArrayBufferTarget } = await import(LIBS[codecs.format]);

  const wasAt = player.getTime();
  const wasPlaying = player.isPlaying();
  player.pause();
  try {
    // comments are left out: a `--` in one breaks the drawing
    const options = { width, height, pixelRatio: 1, filter: (n) => n.nodeType !== Node.COMMENT_NODE };
    options.fontEmbedCSS = await getFontEmbedCSS(root, options);
    const sound = await mixSound(root, from, end);

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: codecs.video[1], width, height, frameRate: fps },
      audio: { codec: codecs.audio[1], sampleRate: RATE, numberOfChannels: CHANNELS },
      ...(codecs.format === 'mp4' && { fastStart: 'in-memory' }),
    });
    let failure = null;
    const fail = (e) => { failure ??= e; };
    const video = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
    video.configure({ codec: codecs.video[0], width, height, framerate: fps, bitrate: 8e6 });
    const frames = Math.max(1, Math.round((end - from) * fps));
    for (let i = 0; i < frames; i++) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      player.seek(from + i / fps);
      const canvas = await toCanvas(root, options);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      video.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      // let the encoder keep up, without a timer a hidden tab would slow
      while (video.encodeQueueSize > 4) await new Promise((r) => video.addEventListener('dequeue', r, { once: true }));
      onProgress((i + 1) / frames);
    }
    await video.flush();

    const audio = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
    audio.configure({ codec: codecs.audio[0], sampleRate: RATE, numberOfChannels: CHANNELS, bitrate: 128000 });
    for (let s = 0; s < sound.length; s += RATE) {
      const n = Math.min(RATE, sound.length - s);
      const data = new Float32Array(n * CHANNELS);
      for (let c = 0; c < CHANNELS; c++) data.set(sound.getChannelData(c).subarray(s, s + n), c * n);
      const chunk = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: CHANNELS, timestamp: Math.round((s * 1e6) / RATE), data });
      audio.encode(chunk);
      chunk.close();
    }
    await audio.flush();
    if (failure) throw failure;
    muxer.finalize();

    const name = (document.title || 'video').trim().replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'video';
    const type = codecs.format === 'mp4' ? 'video/mp4' : 'video/webm';
    return new File([muxer.target.buffer], `${name}.${codecs.format}`, { type });
  } finally {
    player.seek(wasAt);
    if (wasPlaying) player.play();
  }
}

/** Save `file` to the viewer's downloads. */
export function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
