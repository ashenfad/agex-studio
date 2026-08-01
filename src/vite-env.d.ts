/// <reference types="vite/client" />

/**
 * Ambient declarations for the Vite-specific import forms this app
 * uses. `vite/client` covers `?raw` / `?url` / `?worker` on its own;
 * the extras below are the combinations it doesn't declare.
 */

/** `?worker&url` — the worker compiled as an entry point, imported as
 *  a URL string rather than a constructor. Used for the agex-ts
 *  runtime worker, whose bare imports Vite must resolve at build time
 *  (see the prod-build note in `ts-agent.js`). */
declare module '*?worker&url' {
  const src: string
  export default src
}

/** Build-time constant injected by `define` in `vite.config.js`. */
declare const __APP_VERSION__: string

/**
 * Globals attached by scripts we load from a CDN at runtime rather
 * than bundling. Typed loosely on purpose: these are third-party
 * surfaces we call a handful of methods on, and a fuller model would
 * be fiction we'd have to maintain.
 */
interface Window {
  /** Google Identity Services — loaded on demand by `google-auth.js`. */
  google?: any
  /** Google API client — loaded on demand by `google-picker.js`. */
  gapi?: any
  /** Plotly.js — pre-fetched on the parent origin, see `App.svelte`. */
  Plotly?: any
  /** pdf.js — loaded on demand by `pdf-render.js`. */
  pdfjsLib?: any
}

/** GIS/Picker also expose a bare `google` global once loaded. */
declare const google: any

/**
 * Properties the studio stamps onto an *app iframe's* window. The
 * bridge runs inside that frame, so these are its own globals rather
 * than the studio's — declared here because there's no separate
 * program for the injected scripts.
 *
 * Mirrored onto the ambient global below: the control bridge defaults
 * its eval/log scope to `globalThis` when no explicit window is
 * passed, so both halves of that union need the same surface.
 */
declare var __agex_logs: Array<{ level: string; message: string }> | undefined

interface Window {
  /** Origin of the studio parent, stamped by the apps bootloader.
   *  Absent means "don't post" — see `__agexPost` in `app-html.js`. */
  __AGEX_PARENT_ORIGIN?: string
  /** Console-interceptor buffer read back by `testApp`. */
  __agex_logs?: Array<{ level: string; message: string }>
  /** Idempotency latch for `installControlBridge`. */
  __agex_bridge_installed?: boolean
  /** Guarded postMessage helper injected by the console interceptor. */
  __agexPost?: (msg: unknown) => boolean
  /** `window.eval` is real and standard — the global object carries
   *  every global function — but `lib.dom` models `eval` only on
   *  `globalThis`, not on the `Window` interface. The control bridge
   *  calls it indirectly so evaluated code sees app-level bindings. */
  eval: typeof eval
}

interface HTMLIFrameElement {
  /** Latch set by the parent-side bridge's load listener so a frame
   *  that navigates again isn't re-wired. Studio-stamped, not
   *  standard. */
  __navigated?: boolean
}
