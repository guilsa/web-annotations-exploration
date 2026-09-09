# Textmarker B — Pairshare

**Sharing mechanism: live P2P sync between two browsers over a WebRTC
DataChannel.** No server, no account, no link to keep around — two people open
the same page in two browsers, exchange two short copy-paste codes (invite
code = WebRTC offer, join code = answer), and from then on every add / edit /
delete syncs in real time and is saved locally on both sides.

- Signaling: copy-paste codes (base64 SDP). That is the whole "backend".
- Transport: WebRTC DataChannel (`RTCPeerConnection`), default public STUN
  (Google). On a LAN the host candidates connect even with no internet.
- Merge: full-state exchange with last-write-wins by timestamp; deletions are
  propagated via tombstone tracking of the peer's previous state. The first
  exchange never deletes (so an empty side cannot wipe the other).
- If the other side is on a *different* page, you get a notice with the page
  URL and an **Import into this page** action (comments are re-keyed locally).

## Core behavior

1. Select text → floating pill appears with two actions: **💬 Comment**
   (default) and **✏️ Suggest edit**. Highlights are always **yellow** —
   there is no color picker.
2. **Comment** opens a lightweight **thread** in the right-side **comments
   sidebar** anchored to that exact selection. Type the first message and
   **Reply**; further replies accumulate in the same thread, shown in
   chronological order.
3. **Suggest edit** opens a **suggestion** card in the sidebar showing the
   original selected passage as context, with an input pre-filled for the
   proposed replacement. **Submit suggestion** saves it; **Cancel** discards
   a suggestion that has no content yet.
4. Every thread/suggestion is a **card** listing the document location
   (context quote), **author** (two hard-coded gender-neutral names:
   **Riley** on the invite side, **Jordan** on the join side — stored on the
   thread so both peers agree), **timestamp**, and body. A **⋮ (three-dot)
   button** opens an **Edit / Delete** menu. Cards **expand / collapse** via
   their header; a **✕** control closes the whole sidebar.
5. Marks persist per-URL in `browser.storage.local` (key `tmb.pages`) and
   restore on revisit via fuzzy text matching (quote + context + saved
   offset, whitespace-insensitive tiers). Legacy note-marks are upgraded to
   single-message comment threads on load.
6. Hover a highlight → preview card; click **Open thread** (or click the
   highlight) to open it in the sidebar.
7. `Alt+M` — comment on the current selection. `Alt+L` — open/close the
   sidebar. `Alt+P` (or the toolbar button) — open the Pair panel.

## Pairing (two browsers, same page URL)

Browser 1 (invite):
1. `Alt+P` → **Invite** tab → *Generate invite code*.
2. Copy the code, send it to the other person (any channel: chat, email…).

Browser 2 (join):
1. Open the **same page URL** (hash ignored).
2. `Alt+P` → **Join** tab → paste the invite code → *Create join code*.
3. Send the join code back.

Browser 1:
4. Paste the join code into the **Invite** tab → *Connect*.

Both sides show **● Connected**. Now comments flow both ways live: new
threads, replies, submitted / re-proposed suggestions and deletions all
sync in real time, with each side's author name (Riley / Jordan) attached.
*End session* closes the channel (marks remain saved locally).

## Testing

```sh
node tests/run-tests.js b     # 20 unit tests (threads, merge, codes, matcher, DOM)
cd harness && node b.spec.mjs # 15 Playwright e2e tests — includes a REAL
                              # WebRTC session between two tabs (loopback)
```

The e2e suite loads the real add-on into Chromium and verifies the comment
thread + suggestion flows, sidebar card behavior (expand/collapse, ⋮ menu,
close control), and a genuine invite/join handshake with live thread / reply
/ suggestion / delete sync and session teardown across the two tabs.

> Note: the e2e harness runs **headful** (headless Chrome does not register
> this MV3 service worker in the pinned build). It brings its window to the
> front before interactions; if the host keeps stealing focus, the helpers
> fall back to force actions automatically.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3, cross-browser (Firefox + Chromium), `tmb:` commands `Alt+M` / `Alt+L` / `Alt+P` |
| `browser-shim.js` | maps `chrome` → `browser` in Chromium (no-op in Firefox) |
| `background.js` | service worker: relays toolbar + commands (`tmb:toggle-panel`, `tmb:command`) |
| `content.js` | class-based core: `Core` (state/index/threads), `Pair` (WebRTC), `UI` (pill, comments sidebar with thread cards, hover card, pair overlay) + pure thread helpers |
| `icons/` | blue palette |

## Known limits (by design)

- STUN only: symmetric NAT without a TURN server may not connect. LAN and
  most home/office setups work; "zero-config" is the goal, TURN is the escape
  hatch you'd add for the hard 5%.
- Both sides must be on the same page URL (hash ignored) for live merge;
  otherwise the Import-into-this-page notice appears.
- Sync is while-connected: after the session ends, each browser simply keeps
  its (already merged) local state.
