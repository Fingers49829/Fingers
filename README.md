# Fingers
Static HTML pages for the FingersOfSteel.com website

## Rebuilding

- `node tools/build-site.mjs` rebuilds every page from Folkcraft and DulcimerDownloads. A book sold on both stores uses its DulcimerDownloads images.
- Whenever a book's images change, the build also rebuilds that book's one-sheet (`one-sheets/<slug>.pdf`), so one-sheets never show an outdated cover. `--no-one-sheets` skips this.
- `node tools/build-all-one-sheets.mjs` regenerates every one-sheet (needs Microsoft Edge).
