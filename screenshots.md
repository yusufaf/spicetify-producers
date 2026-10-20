# Screenshots — Producers

Captured with the `spicetify-screenshots` skill (`shoot.mjs`) from a live client on the stock theme. Only public albums are shown; no fixtures are needed, because the credits come from Spotify.

## Shot list

| File | Page | Viewport | What it must show |
| --- | --- | --- | --- |
| `producers-album.png` (README hero) | OK Computer `/album/7dxKtc08dYeRVHt3p9CZJn`, tracklist scrolled to the sticky header | 1100×900, `--rect 104,128,932,540 --scale 2` | Titles, the Producers column and durations |
| `producers-column.png` (Marketplace preview, square) | OK Computer, row 1's `+1` hovered with a real `Input.dispatchMouseEvent` | 1100×900, `--rect 656,128,250,250 --scale 3` | The Producers header, a `+1` chip and its open popover, legible at 175px |
| `producers-popover.png` | OK Computer, same hover | 1100×900, `--rect 104,128,932,300 --scale 2` | The `+N` popover in the context of the row |
| `producers-inline.png` | Mother (Logic1000) `/album/2PMAHlFSIxrf1i42NPA83I` | 960×900 | `Logic1000 · Prod. Samantha Poulter, Big Ever` under titles |

## Readiness predicate

```
document.querySelectorAll('.pr-cell .pr-names, .pr-inline .pr-names').length >= 5
```

## Verify before each shot

```
node shoot.mjs verify ".pr-cell .pr-names" --min 5 --within "[role=row]"    # column shots
node shoot.mjs verify ".pr-popover-person" --min 3 --within ".pr-popover"    # popover
node shoot.mjs verify ".pr-inline .pr-names" --min 5 --within "[role=row]"   # inline
```

## Disambiguation

| Looks like ours | Actually | Tell them apart |
| --- | --- | --- |
| Green check next to the duration | Spotify's "Saved" indicator | Not inside `.pr-cell`; ours is text only |
| Grey artist names under titles | Spotify's artist line | Ours starts with `· Prod.` and sits in `.pr-inline` |

## Privacy

Clip to the tracklist only: no sidebar (pinned playlists), no now-playing bar, no avatar. Read every PNG back before committing.
