# Contributing

Contributions are welcome! This is a single-file Spicetify extension with no build step.

## Getting started

1. Fork the repository and clone your fork.
2. `pnpm install` (installs the husky hooks).
3. Copy `producers.js` to your Spicetify Extensions folder:
   - **Windows:** `%APPDATA%\spicetify\Extensions\`
   - **macOS/Linux:** `~/.config/spicetify/Extensions/`
4. `spicetify config extensions producers.js` and `spicetify apply`.

## Development

- `pnpm test` runs a syntax check and the unit tests in `test/` (credits parsing, row matching, the cache, the grid template). The pure helpers are exported through the `module.exports` guard in `producers.js`, so they run under Node.
- `test/fixtures/credits.json` holds real `queryTrackCreditsGroupedModal` responses. Add one when you find a response shape the parser gets wrong.
- For changes to the page itself, follow `tests.live.md` against a running Spotify.
- Debug output is prefixed `[Producers]` in DevTools (`Ctrl+Shift+J` / `Cmd+Option+J`). `window.__producersExtension.stats` shows how many credits were fetched, how many failed, and the most that ran at once.

## Code style

- JSDoc on functions, code grouped in `#region` blocks.
- Select Spotify's DOM by ARIA roles (`role="grid"`, `role="row"`, `aria-colindex`). Spotify 1.3.x hashes its class names.
- Never write to attributes React owns. Add our own elements and style them from our stylesheet.

## Commits and pull requests

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, …). commitlint checks them, and release-please uses them to cut releases. Open an issue first for anything larger than a fix.
