---
name: media
description: Generate images, speech and music with the media host object, for a reply or an app's assets: the options, the voices, how to direct speech and music, and what each costs.
---

# Generated media

`media` makes a file and writes it into the workspace, from `run_ts`.
Each method takes its arguments by name, as one object, and returns
facts read from the file written, so there is nothing to re-check:

| call | writes | returns |
|---|---|---|
| `media.image({ prompt, path, transparent?, aspect?, quality?, references? })` | PNG | `{ path, width, height, alpha, cost }` |
| `media.speech({ text, path, voice?, style? })` | WAV | `{ path, seconds }` |
| `media.music({ prompt, path, length? })` | MP3 | `{ path, seconds, lyrics, cost }` |

Paths are relative to /workspace (not your working directory), and the
name's extension must match what is written. A bad argument fails at
the call, naming what is wrong.

Make several at once with `Promise.all`, in one `run_ts` call rather
than one call each; `Promise.allSettled` keeps the rest when one fails.

```ts
const cast = await Promise.all([
  media.image({ prompt: 'a red fox, flat vector, white background', path: 'app/fox.png' }),
  media.image({ prompt: 'a grey owl, flat vector, white background', path: 'app/owl.png' }),
])
return cast
```

## Where the files go

- **An app's assets:** under `app/`, referenced by relative path in
  its HTML and CSS (`<img src="fox.png">`, `<audio src="theme.mp3"
  loop>`), and through `window.appAssets` from script
  (`new Audio(appAssets['theme.mp3'])`). An app can't call `media`;
  make what it needs ahead of time.
- **Something to show the person:** anywhere, then embed it in your
  reply as an image (`![fox](/workspace/art/fox.png)`) or put its path
  in `ui` (`ui.fox = '/workspace/art/fox.png'`).

## Images

Describe the subject, style, composition, palette and lighting; name
the style outright for game art ("16-bit pixel art", "hand-painted",
"flat vector icon").

- `transparent: true` gives a real alpha channel, for sprites, icons
  and overlays (not a painted checkerboard).
- `aspect`: `1:1` (the default), `3:2`, `2:3`, `4:3`, `3:4`, `16:9`,
  `9:16` or `21:9`.
- `quality`: `low` (the default: about 11s and $0.006 for a square),
  `medium`, `high`, `xhigh`, `max`. Keep `low` for drafts and bulk
  sprites, and go higher for hero art.
- `references`: up to 16 workspace images to work from. Pass earlier
  images to keep a character or a style consistent across a set, or one
  image with an instruction to edit it ("the same knight, armor
  recoloured crimson").

Once the call has returned (the file doesn't exist before), look at the
image with view_image on the returned path before you use it.

## Speech

`text` is spoken word for word, so it holds only what is said: a
direction written into it (`[whispers]`, "Say warmly:") is read aloud.
Say how it is said in `style`, in plain words: `"whispering,
conspiratorial"`, `"warm and unhurried"`, `"excited, fast"`. Momentary
sounds go inline in angle brackets and are performed, not read:
`<laugh>`, `<sigh>`, `<breath>`, `<gasp>`, `<short pause>`, `<long
pause>`. Write names, acronyms and symbols the way they should sound.

```ts
await media.speech({
  text: "It's here. <laugh> It's really here!",
  path: 'app/vo/arrival.wav',
  voice: 'Puck',
  style: 'breathless, delighted',
})
```

`seconds` is the clip's length: time scenes and captions to it. A WAV
is about 48KB a second, so keep clips to what is used, and split long
narration into lines.

**Voices** (default Kore), one per character:

| voice | tone | voice | tone | voice | tone |
|---|---|---|---|---|---|
| Kore | firm | Puck | upbeat | Charon | informative |
| Zephyr | bright | Fenrir | excitable | Leda | youthful |
| Aoede | breezy | Sulafat | warm | Achernar | soft |
| Algenib | gravelly | Orus | firm | Callirrhoe | easy-going |
| Autonoe | bright | Enceladus | breathy | Iapetus | clear |
| Umbriel | easy-going | Algieba | smooth | Despina | smooth |
| Erinome | clear | Rasalgethi | informative | Laomedeia | upbeat |
| Alnilam | firm | Schedar | even | Gacrux | mature |
| Pulcherrima | forward | Achird | friendly | Zubenelgenubi | casual |
| Vindemiatrix | gentle | Sadachbia | lively | Sadaltager | knowledgeable |

## Music

All control is in the prompt: genre, instruments, tempo, key and mood,
and "no vocals" for an instrumental (a bed under narration, a game's
background).

- `length: 'clip'` (the default) is about 30s, $0.04 and about 10s to
  make. `'song'` follows the length the prompt asks for, roughly ($0.08,
  about 25s), so read `seconds` back.
- `lyrics` is every sung line in order, `[{ at, line }]`: `at` is when
  it starts, in seconds, for a clip's lines, and null for a song's,
  which come untimed. An instrumental's is empty.
- There is no seamless loop: for a background loop, ask for ambient
  material without hard downbeats and use `<audio loop>`.

## Cost

Every call is a billed request on the person's OpenRouter key, and the
result says what it cost where the provider reports it. Make what was
asked for; draft at `low` and in clips, and make the expensive version
once the cheap one is right.
