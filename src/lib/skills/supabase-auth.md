# Supabase auth & shared state

Give an app **real users and shared, persistent state** — accounts,
cross-device sync, data shared between people — backed by Supabase
(hosted Postgres + auth + row-level security). Use this instead of
rolling your own accounts/passwords or stashing everything in
per-browser localStorage.

## Mental model

- **Supabase Auth owns identity.** It issues a session JWT; that JWT is
  what your row-level-security (RLS) policies check (`auth.uid()`) to
  decide which rows a user may read/write. You never store passwords.
- **"Sign in with Google" is just a provider.** Google (or GitHub,
  magic-link, etc.) is configured in the Supabase project dashboard, not
  in your app. Google redirects to *Supabase's* callback, Supabase
  exchanges it and issues the session. You are not implementing a Google
  OAuth client — you're calling `supabase.auth.signInWithOAuth`.
- **The anon key is public.** It ships in app code by design; RLS is the
  actual guard. Never put the `service_role` key in an app — it bypasses
  RLS.

## The one studio-specific rule: popup, not redirect

Your app is served into the iframe by a bootloader (`document.write`), so
a normal redirect-based sign-in (`signInWithOAuth` navigating the whole
page to Google and back) would reload the bootloader and **lose all app
state**. Don't do that.

Instead: open the auth URL in a **popup** with `skipBrowserRedirect`, and
point `redirectTo` at the studio's relay page. The relay catches the
return and hands it back to your still-running app over a same-origin
`BroadcastChannel`. The app never navigates away.

```
Relay URL (redirectTo):  https://apps.agex.studio/auth-relay.html
BroadcastChannel name:   'agex-oauth'
Message shape:           { type: 'agex-oauth-return', params: { code, state, ... } }
```

## Sign-in (copy this pattern)

`@supabase/supabase-js` resolves automatically — just import it bare; the
studio routes it to esm.sh like any npm package.

```js
import { createClient } from "@supabase/supabase-js";

// SUPABASE_URL + the public anon key — safe to ship in app code.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY); // PKCE is the default flow

const RELAY = "https://apps.agex.studio/auth-relay.html";

async function signInWithGoogle() {
  // Open the popup *synchronously* inside the click handler (the async
  // gap below would otherwise lose the user-gesture and the popup
  // blocker would eat it). Bail clearly if it was blocked.
  const popup = window.open("about:blank", "agex-oauth", "width=480,height=640");
  if (!popup) throw new Error("Sign-in popup blocked — allow popups for this site and retry.");

  try {
    // Per-attempt nonce so a sign-in running in another tab on this same
    // origin can't satisfy *this* flow's BroadcastChannel listener. It
    // rides on redirectTo so it survives the round-trip; the match below
    // fails open, so the flow still works even if it doesn't come back.
    const nonce = crypto.randomUUID();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { skipBrowserRedirect: true, redirectTo: `${RELAY}?agex=${nonce}` },
    });
    if (error) throw error;
    popup.location.href = data.url; // → Supabase → Google → Supabase → RELAY

    const params = await new Promise((resolve, reject) => {
      const channel = new BroadcastChannel("agex-oauth");
      let settled = false;
      const cleanup = () => { settled = true; clearTimeout(timer); clearInterval(poll); channel.close(); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("sign-in timed out")); }, 120_000);

      // Don't hang the full timeout if the user closes the popup. The
      // relay closes it itself right after posting success, so give a
      // short grace for an in-flight message before treating it as a
      // manual close.
      const poll = setInterval(() => {
        if (!popup.closed || settled) return;
        clearInterval(poll);
        setTimeout(() => { if (!settled) { cleanup(); reject(new Error("sign-in popup closed")); } }, 600);
      }, 500);

      channel.onmessage = (e) => {
        if (e.data?.type !== "agex-oauth-return") return;
        const p = e.data.params || {};
        if (p.agex && p.agex !== nonce) return; // another tab's flow — ignore (fails open if absent)
        cleanup();
        resolve(p);
      };
    });

    if (params.error) throw new Error(params.error_description || params.error);
    // PKCE: the code verifier was stored in THIS client's storage (same
    // origin) at signInWithOAuth time, so the exchange must run here.
    if (params.code) await supabase.auth.exchangeCodeForSession(params.code);
    // `supabase` now carries the session — RLS-gated reads/writes just work.
  } catch (err) {
    popup?.close(); // ensure the popup is cleaned up on any failure
    throw err;
  }
}
```

`exchangeCodeForSession` only happens once (the `code` is single-use and
PKCE-bound to this client). On later loads, the session restores from the
client's storage automatically — no popup needed unless it expired.

## Reacting to auth state

```js
const { data: { session } } = await supabase.auth.getSession();
supabase.auth.onAuthStateChange((_event, session) => {
  // session is null when signed out — re-render gated UI accordingly.
});
async function signOut() { await supabase.auth.signOut(); }
```

## Shared state (RLS does the work)

With a session in hand, normal Supabase queries are scoped by your RLS
policies — no per-request auth wiring:

```js
// Read rows this user is allowed to see.
const { data, error } = await supabase.from("notes").select("*");
// Insert; user_id defaults to auth.uid() via a column default + policy.
await supabase.from("notes").insert({ body: "hello" });
// Live updates shared across everyone with access:
supabase.channel("notes")
  .on("postgres_changes", { event: "*", schema: "public", table: "notes" },
      (payload) => { /* merge payload.new / payload.old into UI */ })
  .subscribe();
```

## One-time setup (done by the project owner in dashboards, not in app code)

1. **Supabase → Authentication → Providers → Google:** enable it, paste a
   Google OAuth client ID + secret. Google's authorized redirect URI is
   `https://<project-ref>.supabase.co/auth/v1/callback` (Supabase's, not
   yours).
2. **Supabase → Authentication → URL Configuration → Redirect URLs:** add
   `https://apps.agex.studio/auth-relay.html`. Supabase only redirects to
   allow-listed URLs; the `?agex=` nonce the app appends is matched on
   path, so the bare entry is enough (add `.../auth-relay.html?*` if your
   project is configured to match query strings strictly).
3. **Tables + RLS:** enable row-level security on shared tables and write
   policies keyed on `auth.uid()` (e.g. `using (auth.uid() = user_id)`).
   Without RLS, the public anon key lets anyone read everything.

If sign-in fails with a redirect/`redirect_to is not allowed` error,
step 2 is missing or misspelled.

## Footguns

- **Popup blocked?** You opened it after an `await` — open the blank
  popup synchronously in the click handler first, then set its `location`.
- **Exchange in the app, not elsewhere.** The PKCE verifier lives in this
  client's storage; only this origin can complete the exchange.
- **Cross-tab interference.** `BroadcastChannel` is origin-wide, so a
  sign-in in another tab on this origin would post to the same channel.
  The per-attempt `agex` nonce above filters that out (don't rely on the
  OAuth `state` — Supabase doesn't surface it on `redirectTo`). Even
  without the filter it fails safe: a code is PKCE-bound to the client
  that started the flow, so another tab can't exchange it.
- **`service_role` key never ships to an app.** Anon key + RLS only.
