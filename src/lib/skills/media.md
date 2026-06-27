# Generative Media

Three host functions generate media from a prompt, each returning a
`Uint8Array` you place however you like. Same OpenRouter key as `search`;
fan any of them out with `Promise.all`.

| Function | Output | Picked by |
|---|---|---|
| `createImage(prompt, { image?, quality? })` | PNG | `quality: 'standard' \| 'high'` (Nano Banana → Pro); `image` = edit / compose reference(s) |
| `createMusic(prompt, { length? })` | MP3 | `length: 'clip'` (30s) \| `'full'` (song) |
| `createSpeech(text, { voice? })` | WAV (24 kHz mono) | `voice` (one per character) |

## Two ways to use the bytes

- **App asset** — `await fs.write('app/assets/x.png', bytes)`, then
  reference `assets/x.png` in app code (`<img>`, `<audio>`). It lives in the
  VFS and isn't re-committed per message. Use this for anything the app
  itself shows or plays.
- **Chat reply** — return it as a part: `taskSuccess({ type: 'image' | 'audio', data: bytes, title? })`. Renders inline (an image, or an audio
  player). A chat part is committed into the session, so reserve it for
  something the *user* views / listens to once — not bulky app assets.

## Images — `createImage`

Describe subject, style, composition, palette, lighting. For game art, name
the style explicitly ("16-bit pixel art", "hand-painted", "flat vector
icon") and ask for a transparent background when you need a sprite.

```ts
const sprite = await createImage('16-bit pixel-art knight, idle pose, transparent background')
await fs.write('app/assets/knight.png', sprite)

// Edit / compose — pass reference image(s); multiple compose together.
const crimson = await createImage('recolor the armor to crimson',
                                  { image: await fs.read('app/assets/knight.png') })
```

`quality: 'high'` (Nano Banana Pro) is slower and higher-fidelity — reach
for it on hero art, not bulk tiles.

## Music — `createMusic`

All control lives in the prompt — genre, instruments, tempo (BPM), key,
mood, and structure tags. There is **no** duration, seed, or loop param.

```ts
const bg = await createMusic('lo-fi hip hop, mellow Rhodes piano, vinyl crackle, 80 BPM, A minor')
await fs.write('app/assets/bg.mp3', bg)   // <audio src="assets/bg.mp3" loop>
```

- `length: 'clip'` = a 30s clip (default, cheap); `'full'` = a longer
  structured song (shape it with `[Intro]`/`[Verse]`/`[Chorus]` tags).
- **Looping:** there's no seamless-loop or exact-length control. For a
  background loop, prompt for *ambient* material with no hard downbeats and
  rely on `<audio loop>` — the seam is best-effort.

## Speech — `createSpeech` (character dialog)

Two levers: the **voice** (timbre, picked per character) and **inline tags**
(performance, written into the text per line).

```ts
const vo = await createSpeech(
  '[weary] Another traveler... [suddenly sharp] you should not be here.',
  { voice: 'Charon' })
await fs.write('app/assets/vo/innkeeper_01.wav', vo)
```

Output is **WAV** (Gemini emits PCM; it's wrapped into a playable .wav).
WAV is uncompressed (~48 KB/sec), so a line or two is fine but long
narration gets big — a clip past ~20s exceeds the app-inline 1 MB budget.
Keep VO to lines / short takes; split long narration.

### Voices — assign one per character (default `Kore`)

| Voice | Tone | | Voice | Tone |
|---|---|---|---|---|
| Zephyr | Bright | | Erinome | Clear |
| Puck | Upbeat | | Algenib | Gravelly |
| Charon | Informative | | Rasalgethi | Informative |
| Kore | Firm | | Laomedeia | Upbeat |
| Fenrir | Excitable | | Achernar | Soft |
| Leda | Youthful | | Alnilam | Firm |
| Orus | Firm | | Schedar | Even |
| Aoede | Breezy | | Gacrux | Mature |
| Callirrhoe | Easy-going | | Pulcherrima | Forward |
| Autonoe | Bright | | Achird | Friendly |
| Enceladus | Breathy | | Zubenelgenubi | Casual |
| Iapetus | Clear | | Vindemiatrix | Gentle |
| Umbriel | Easy-going | | Sadachbia | Lively |
| Algieba | Smooth | | Sadaltager | Knowledgeable |
| Despina | Smooth | | Sulafat | Warm |

### Inline tags — direct the performance mid-line

Write them into the text; they steer delivery and aren't spoken aloud.

- **Non-verbal:** `[whispers]` `[shouting]` `[laughs]` `[sighs]` `[gasp]` `[cough]`
- **Emotion:** `[amazed]` `[crying]` `[curious]` `[excited]` `[panicked]` `[sarcastic]` `[serious]` `[tired]` `[trembling]` `[mischievously]`
- **Pacing:** `[very fast]` `[very slow]` `[sarcastically, one painfully slow word at a time]`
- **Creative:** `[like a cartoon dog]` `[like dracula]` `[bored]` `[reluctantly]`

### A cast, fanned out

```ts
const cast = { innkeeper: 'Charon', child: 'Leda', villain: 'Algenib' }
const lines = [
  { who: 'innkeeper', text: '[weary] We are closed.' },
  { who: 'child',     text: '[excited] Did you see the dragon?!' },
  { who: 'villain',   text: '[mischievously] All according to plan.' },
]
const clips = await Promise.all(
  lines.map((l) => createSpeech(l.text, { voice: cast[l.who] })))
await Promise.all(clips.map((b, i) => fs.write(`app/assets/vo/line_${i}.wav`, b)))
```

## Cost & latency

Each call is a billed request. `quality:'high'` images and `length:'full'`
songs are slower and pricier — use them deliberately. Generate sets
concurrently with `Promise.all`, but a big batch is a big bill.
