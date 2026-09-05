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

1. Select text → floating pill appears with **four marker colors**
   (yellow, blue, green, pink). Pick a color, click **💬 Comment** — the last
   used color is remembered per browser.
2. Write a note (or leave it empty for a plain highlight) → Save.
3. Marks persist per-URL in `browser.storage.local` (key `tmb.pages`) and
   restore on revisit via fuzzy text matching (quote + context + saved
   offset, whitespace-insensitive tiers).
4. Hover a highlight → comment card; click → pinned card with **Edit /
   Close**. Edit prefills the note.
5. `Alt+M` — comment on the current selection.
6. `Alt+P` (or the toolbar button) — open the Pair panel.

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

Both sides show **● Connected**. Now comments flow both ways live.
*End session* closes the channel (marks remain saved locally).

## Testing

```sh
node tests/run-tests.js b     # 12 unit tests (merge logic, codes, matcher, DOM)
cd harness && node b.spec.mjs # 7 Playwright e2e tests — includes a REAL
                              # WebRTC session between two tabs (loopback)
```

The e2e suite loads the real add-on into Chromium and performs a genuine
invite/join handshake, then verifies live add / edit / delete sync and
session teardown across the two tabs.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3, cross-browser (Firefox + Chromium), `tmb:` commands `Alt+M` / `Alt+P` |
| `browser-shim.js` | maps `chrome` → `browser` in Chromium (no-op in Firefox) |
| `background.js` | service worker: relays toolbar + commands (`tmb:toggle-panel`, `tmb:command`) |
| `content.js` | class-based core: `Core` (state/index/marks), `Pair` (WebRTC), `UI` (pill with color dots, editor, card, pair overlay) |
| `icons/` | blue palette |

## Known limits (by design)

- STUN only: symmetric NAT without a TURN server may not connect. LAN and
  most home/office setups work; "zero-config" is the goal, TURN is the escape
  hatch you'd add for the hard 5%.
- Both sides must be on the same page URL (hash ignored) for live merge;
  otherwise the Import-into-this-page notice appears.
- Sync is while-connected: after the session ends, each browser simply keeps
  its (already merged) local state.
