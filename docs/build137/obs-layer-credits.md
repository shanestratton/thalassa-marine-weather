# Obs layer credits

Obs uses one 44 px Credits row below the map-base picker. Opening it shows the active layers' full source names, licences, DOI links, satellite frame time/play control and AIS/lightning status in a scrollable sheet. The linked RainViewer or Rainbow.ai name remains in the closed row. A warning mark indicates unavailable, stale or unknown feed status.

Mapbox's existing logo, attribution control and dynamic map-source credits remain unchanged. ENC source/currency/CATZOC notices remain separate. Embedded/planner weather credits retain their existing presentation; only Obs opts into the rollup. Layer controls and network permissions are unchanged.

## Source proof

- Actual Chrome and WebKit: all 12 combinations of 300/375/430 px and normal/130% root text passed, with five active groups. `work/credits137-browser-verified-warm.log` and `work/credits137-browser-verified-results/` in the task workspace retain the results and screenshots.
- Assertions require an exact 44 px row, at least 5 px clearance below the base picker and 4 px sideways clearance from MOB; button/link hit targets, warning-state fit, real map logo/attribution, source links and satellite play remain usable. The map/canvas/page bounds and scroll extent must be identical before/after opening, closing, Clear View and the layer-menu scrim.
- The offset follows both the picker's 44 px minimum and its rem-scaled height. The earlier 300 px normal-text overlap failure and the cold warm-up timeout are retained; neither deadlines nor geometry assertions were relaxed.
- Synthetic local map/status inputs only; all provider requests were intercepted. This does not prove provider availability or licensed map access.
- Whole-app TypeScript, configured production budget and the complete release suites are checked on the final composed build by the release owner.
