# Build 136: private Pi track replay

The recorder card opens a lazy history sheet. Reads go only over the existing paired, pinned boat-LAN lane. The selected UTC window is explicit; changing its dates does not start a request. No track data is uploaded or persisted by this viewer.

## Bounded history protocol

The additive `page=1` endpoint returns an `(at_ms,rowid,snapshot)` cursor and fixes the first page's maximum rowid for the entire read. Equal timestamps at a page boundary are retained. Appends, including backdated appends, cannot enter the snapshot. Legacy endpoint callers retain their existing response. A legacy Pi response cannot establish complete history: the app asks for a Pi update.

The reader allows at most 500 fixes per page, 20 pages, 10,000 fixes, 1 MiB per response, 8 MiB overall and a 20-second monotonic deadline. Callers can request lower row/page caps. Bounds stop with an explicit partial result. Loading the remaining batch replaces the displayed batch and keeps the partial-window warning even when it reaches the final cursor. Neither that final tail nor its exports claims to include the omitted prefix.

Account generation, paired key/device identity and boat-LAN base are fenced across asynchronous replies. Cancellation prevents any later reply or page from entering the view. Source positions, original sensor clocks and missing values are preserved; a sample time never becomes an invented sensor clock or qualified true heading.

## Replay and exports

Five graphs show logged speed over ground, true wind speed, depth, pressure and heel. Missing measurements and gaps over five minutes break the graph. CSV preserves explicit field units, UTC and optional source clocks; string cells that could become spreadsheet formulas are neutralized. GPX has separate segments at long gaps, escaped XML and explicit partial metadata.

The existing TrackMapViewer supplies the timeline, UTC readouts and controls. Its private mode uses a local SVG coordinate plot, with an unwrapped antimeridian, recorded positions and a playback marker. It loads no map SDK, chart, image, authentication or telemetry request. It draws no line over a gap longer than five minutes and does not invent intermediate playback positions. The UI identifies it as a local plot, not chart coverage or a measured voyage distance. Ordinary Log map rendering remains unchanged.

Exports use the existing native share/browser download path and unique filenames. No external share recipient is selected automatically.

## Evidence and deployment status

- Reader, replay, sheet, local plot and existing Log-map regressions: 96 focused tests passed.
- Real Chrome and WebKit: six cases passed at 300 px and 30% enlarged text, including actual local plot screenshots, nested Escape/focus return, partial GPX artifact, legacy update/cancellation and 10,000 generated fixes.
- Actual native SQLite/HTTP proof: GitHub run `38889308304`, pinned source `34ab952504f64fbc52d9597d7bd9a3763d4ec1d7`, definition `903ac6da3ffff62939048f6d01c04fd9eb9c888e`: 24 tests passed, Pi TypeScript passed. No secrets or deployment permissions were used.

The new Pi endpoint requires the later reviewed Pi update. This checkpoint does not install it or claim that the current boat has it. All fixtures use generated positions and measurements.
