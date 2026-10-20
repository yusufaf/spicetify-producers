# Live Tests — Producers

Extension file: `producers.js`
Use the `spicetify-live-test` skill for CDP mechanics (eval, screenshot, console). The file can be evaluated straight into the client; a re-evaluated copy destroys the previous one.

## Storage keys

| Key | Contents |
|-----|----------|
| `producers-config` | `{"albums":true,"playlists":true}` |
| `producers-cache` | JSON array of `[trackUri, savedAtMs, [[name, role, artistId|null]]]` |

## Smoke test (after every edit)

1. `pnpm test`.
2. Inject or reload; console (filter `Producers`) shows `[Producers] vX initialized, N cached tracks.` and no `[Producers]` errors.
3. Open an album; screenshot.

## T1: Column on a wide album page

- Open an album with the window wide (tracklist ≥ 900px).
- Expect a **Producers** header before the duration, names in grey, aligned under the header.
- `document.querySelectorAll('.pr-cell').length` equals the number of rendered rows.

## T2: +N popover

- Open an album where tracks have 3+ producers (OK Computer: `spotify:album:7dxKtc08dYeRVHt3p9CZJn`).
- Hover `+1`: popover lists everyone under a role heading; names with artist pages are links.
- Click a link: navigates to the artist page and the popover closes. The row does not start playing.
- Scroll while the popover is open: it closes.

## T3: Large playlist, fast scroll

- Open a 1,500+ track playlist; note `window.__producersExtension.stats`.
- Scroll from top to bottom in about 3 seconds.
- Expect `maxInFlight` ≤ 4, `failed` 0, and far fewer fetches than rows passed (rows scrolled past are dropped from the queue). No row has two `.pr-cell`s.
- Spot-check a few "—" rows against a direct `queryTrackCreditsGroupedModal` call: none should have a producer role.

## T4: Narrow window → inline

- Emulate a narrow viewport (`Emulation.setDeviceMetricsOverride` width 960, then clear it), or open the Now Playing panel.
- Expect no `.pr-cell`/`.pr-header`, no `.pr-active` on the grid, and `· Prod. Name` on the artist line for rows whose producer isn't the artist.
- Widen again: the column comes back.

## T5: Native column toggles

- Turn on one of Spotify's own columns (List → Columns, e.g. Plays on an album).
- The Producers cell stays under its header (it's placed by `grid-column: producers`).

## T6: Columns menu toggle

- List → Columns shows a **Producers** checkbox matching the setting for this page type.
- Unchecking removes every `.pr-cell`/`.pr-inline` and the grid override; `producers-config` updates. Checking brings them back.

## T7: Navigation

- Album → playlist → album: each page renders its own producers; no cells left over on other pages (home, artist, search).
