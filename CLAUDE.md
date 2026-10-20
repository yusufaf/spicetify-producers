# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Spicetify extension (`producers.js`, no build step) that adds a Producers column, built from Spotify's own track credits, to album and playlist tracklists. One IIFE: pure helpers first (exported for Node tests), then everything that touches the DOM and `Spicetify.*`.

## Commands

```bash
pnpm test          # node --check producers.js && node --test "test/*.test.js"
pnpm install       # installs husky hooks via `prepare`
```

Husky runs `pnpm test` on pre-commit and commitlint (config-conventional) on commit-msg. release-please cuts releases from Conventional Commits and bumps the version markers in `producers.js`, `package.json` and `version.txt`.

## Testing in the real client

Use the `spicetify-live-test` skill. The extension can be evaluated straight into a running client over CDP without `spicetify apply`. Re-evaluating is safe: `main()` calls `window.__producersExtension.destroy()` on any previous instance first. `tests.live.md` lists the scenarios.

## Architecture

**Data.** Credits come from `Spicetify.GraphQL.Definitions.queryTrackCreditsGroupedModal` with `{ trackUri }`. The response is `data.trackUnion.creditsTrait.contributors.items[] = { name, role, roleGroup: { name }, uri, url }`. Roles are English display strings with no stable key; `PRODUCER_ROLES` lists the ones that count. The older `queryTrackCreditsModal` no longer exists on Spotify 1.3.x. **Never call `api.spotify.com`** (the Web API): the client token gets 429s there.

**Row → track.** Tracklist rows expose no track URI (titles aren't links). On navigation, `loadIndex` fetches the page's tracks (`getAlbum` / `PlaylistAPI.getContents`), and `buildTrackIndex` keys them by lowercased title + `m:ss` duration (seconds floored, matching what the row shows). Rows are read with `directTextContent` so injected nodes can never feed back into the key. A miss on a loaded index triggers a throttled reload (tracks added to a playlist while viewing it).

**Selectors.** Spotify 1.3.x hashes tracklist class names and dropped `data-testid`s and `.Root__main-view`. Select by ARIA only: grid `[role="grid"][aria-rowcount]` inside `#main-view`, rows `[role="row"][aria-rowindex]` (header = rowindex 1), cells `[role="gridcell"][aria-colindex]`. Title is the first `div` with direct text in colindex 2; duration is the `m:ss` text in the last cell.

**Two display modes**, picked by grid width (`COLUMN_MIN_GRID_WIDTH`), not `aria-colcount`, which also drops when the user hides native columns:
- *column*: an `!important` stylesheet rule on `.pr-active` rewrites `--grid-template-columns` (inline on the grid, React-owned) with a `[producers]` track before `[last]`. Cells are placed with `grid-column: producers`, so DOM order doesn't matter when React inserts newly enabled native columns.
- *inline*: a `.pr-inline` span appended to the artist line, re-appended on every render (React can append artist links after it). The subtitle is flexed via `div:has(> .pr-inline:not(:empty))` so no React-owned attribute is touched.

**Idempotency.** Each injected node carries `data-pr-stamp = mode|uri|state|count`. A render pass that finds a matching stamp does nothing, so the MutationObserver firing on our own writes settles after one no-op pass. Observers watch `childList` plus `aria-colcount` only; never other attributes.

**Fetch queue.** At most `MAX_CONCURRENT` in flight and `MAX_PER_MINUTE` started per minute. `wanted` is rebuilt each render pass from the rows on screen, and queued URIs not in it are dropped, which is what keeps fast scrolling cheap. A failure backs off the whole queue exponentially; after `MAX_ATTEMPTS` a track is given up for the session (not cached). Successful results, including `[]` ("no producers"), go in the LRU/TTL cache.

**Columns menu.** `augmentColumnsMenu` watches `<body>` for Spotify's Columns menu (`button[role="menuitemcheckbox"][data-column]`) and clones an item as `data-column="PR_PRODUCERS"`. The clone has no React props, so our click listener owns it.

### Storage keys

| Key | Contents |
|-----|----------|
| `producers-config` | `{ albums: boolean, playlists: boolean }` |
| `producers-cache` | `[[trackUri, savedAtMs, [[name, role, artistId \| null], …]], …]`, LRU order, 30-day TTL, 5,000 entries max |

## Conventions

- Commit messages: Conventional Commits, short and imperative.
- Keep the pure helpers above the `module.exports` guard and add tests for them in `test/`.
- Don't add comments that restate the code; do explain Spotify quirks that force a choice.
