<div align="center">

# 🖍️ Textmarker Revamped

**Highlight the web, comment in context, and share without an account or central database.**

</div>

Three deliberately different re-implementations of
[Textmarker](https://github.com/underflyingbirches/Textmarker), each exploring
a distributed way to share page comments. Each implementation is designed as a
standalone browser extension written in plain JavaScript: no build step,
dependencies, or configuration. Linkshare and Pairshare are complete and
end-to-end tested; Pinshare is planned.

## Choose how comments travel

| Variant | How it shares | State |
|---|---|---|
| 🔗 `version_a` — **Linkshare** | Packs comments into the URL fragment. The link is the database: offline, portable, and server-free. | Ready |
| 🤝 `version_b` — **Pairshare** | Syncs two browsers live over a WebRTC DataChannel using copy-paste invite and join codes. | Ready |
| 📌 `version_c` — **Pinshare** | Will publish a standalone comment sheet through a local IPFS node or a downloadable HTML file. | Planned |

## What they have in common

- Select text, add a comment, and get a colored highlight.
- Keep comments per page in `browser.storage.local`.
- Restore highlights after a revisit with fuzzy text matching.
- Hover or click a highlight to read, edit, delete, or import its comment.

The implementations are intentionally distinct—different architecture, UI,
storage keys, and colors—rather than three skins over the same codebase.

## Try one

In Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load
Temporary Add-on…**, and select `version_a/manifest.json` or
`version_b/manifest.json`. In Chromium, enable Developer mode at
`chrome://extensions` and load either directory unpacked.

## Layout

```
version_a/  manifest.json browser-shim.js background.js content.js icons/  (complete)
version_b/  manifest.json browser-shim.js background.js content.js icons/  (complete)
version_c/  (icons only so far)
tools/make-icons.js   dependency-free PNG icon generator (pure node zlib)
tests/fake-dom.js     minimal fake DOM for unit-testing content-script core
tests/run-tests.js    unit test runner:  node tests/run-tests.js a|b|c|all
harness/              Playwright e2e harness (pnpm; loads the real add-on in Chromium)
check_in.md           session check-ins
```

## Status

- [x] A: core + share link + 19 unit tests + 10 Playwright e2e tests (local page
      **and live Wikipedia**), all passing. Fixed in the process: missing
      `openEditor`, no-persist-on-create, close-then-read-null bugs, off-screen
      editor placement, shared-mark retry, boot races.
- [x] B: core with 4 marker colors + Pair overlay (RTCPeerConnection
      invite/join, full-state merge with tombstones, status display, end
      session) + 12 unit tests + 7 Playwright e2e tests, all passing — the
      e2e runs a real WebRTC DataChannel session between two tabs and verifies
      live add / edit / delete sync. Fixed in the process: `core.ui` never
      assigned (editor never opened), wrong-`this` in editor open, panel tab
      visibility in the harness.
- [ ] C (revised 2026-09-05): core + comment list widget + sheet generation
      (`</script>`-safe JSON island, round-trip property tests) + publish to a
      local Kubo node if present (probed on localhost, zero-config default 5001)
      + sheet-file download lane + sheet detection/import. Test arch: mock IPFS
      in the harness (valid deterministic CIDv1s via sha256 → raw codec →
      base32), opt-in js-ipfsd-ctl contract test, opt-in read-only public
      gateway smoke. NOTE: the original "public `api.ipfs.io/api/v0/add`" plan
      is dead — probed: `ipfs.io/api/v0/add` → HTTP 410 "Kubo RPC is not
      here"; the public gateway is retrieval-only, and Kubo RPC is
      admin/localhost-bound by design.
- [ ] READMEs for C; final top-level polish

## Prior work

This project is inspired by [Textmarker](https://github.com/ufb/Textmarker).
It revisits Textmarker's highlighting and annotation workflow through
independent implementations focused on portable, distributed sharing.
