# textmarker-revamped

Three **simple, unique, zero-config** Firefox re-implementations of
[Textmarker](https://github.com/underflyingbirches/Textmarker), each with a
different *distributed* way to share page comments. Plain JS, no build step,
no dependencies — load each folder as a temporary add-on in Firefox.

| Variant | Sharing mechanism | Where comments live |
|---|---|---|
| `version_a` — **Linkshare** ✅ done | Comments embedded in the URL fragment (`#…&tmc=<base64 JSON>`). The link *is* the database. | Link (offline, no server) + `browser.storage.local` per page |
| `version_b` — **Pairshare** (next) | Live P2P sync between two browsers over a WebRTC DataChannel. Signaling is copy-paste of an invite/join code (public STUN default, LAN works without it). | Both browsers' local storage, synced in real time |
| `version_c` — **Pinshare** (after) | Publish the page's comments as a standalone HTML "comment sheet" to IPFS via the public `api.ipfs.io` gateway. Permanent content-addressed link; the sheet renders even without the extension. | IPFS (content-addressed) + local storage |

All variants share the same core idea (simpler than the reference):

1. Select text → floating pill → add a comment → colored highlight.
2. Persist per-URL in `browser.storage.local`.
3. Restore on revisit via fuzzy text matching (quote + context + saved offset).
4. Hover/click a highlight → comment card (edit, delete, import).

Each variant is implemented differently on purpose (single-file IIFE vs
class-based vs multi-file; different UIs, storage keys, colors).

## Layout

```
version_a/  manifest.json background.js content.js icons/  (complete)
version_b/  (icons only so far)
version_c/  (icons only so far)
tools/make-icons.js   dependency-free PNG icon generator (pure node zlib)
tests/fake-dom.js     minimal fake DOM for unit-testing content-script core
tests/run-tests.js    test runner:  node tests/run-tests.js a|b|c|all
check_in.md           session check-ins
```

## Status / next session

- [x] A: core + share link + tests (19 passing)
- [ ] B: core (4 marker colors) + Pair overlay (RTCPeerConnection invite/join,
      full-state merge on each change, status display, end session)
- [ ] C: core + comment list widget + Publish to IPFS (background fetch with
      gateway fallbacks) + comment-sheet detection/import
- [ ] READMEs for B and C; final top-level polish

Budget note: 2h max per work session (see `check_in.md`).
