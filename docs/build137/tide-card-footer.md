# Tide provenance without enlarging the Glass

The tide card keeps its existing width, height and page allocation. At an internal height of at least 170 px, source/station text and the two 44 px actions occupy a reserved footer below the complete canvas, including its hour axis. The canvas flexes inside the card. Long station text has a complete accessible description and remains fully readable in Source and datum.

Below that height, including the 85 px card, there is no footer. The height readout is a 44 px source disclosure with visible provider credit. H/L captions retain full accessible names, the common height unit remains beside the current height, and +1 explicitly marks next-day clocks. Source and datum contains full station/datum/attribution/licence details and the Offline tides action. On a compact all-day card, the first two event readings remain on the face and the disclosure contains the full event table; it does not present the current clock's height as an all-day reading.

Caption wrapping on taller narrow cards prevents the height and high/low values colliding. Footer/disclosure activation does not trigger the surrounding wind-versus-tide card. Escape and Tab remain available to the shared modal focus handling. Freshness, datum and informational-only tide rules are unchanged; no forecast/provider request was added.

## Local proof

- Original source: `47cb5cf7b7d1f9f91323f6e34f5f6a2eb35b810a`; original TideGraph SHA256 `834204a704f827385f017b4e9eee3488fe2a79f6ddc6ce9adba55ef09cbdf0ca`.
- 36 exact before/after comparisons: card bounds, following model-strip bounds, page scroll width/height are identical at 300/375/430 px, normal/130% text, 85/150/180 px card heights, in installed Chrome and WebKit. Compact cases use 640/667/932 px phone viewport heights; 180 px cases use 850 px. Baseline uses the unchanged original component through an external development-only loader, never a production switch.
- 70/70 browser checks passed: 38 provenance/size/actual-canvas-pixel/action cases and all 32 existing wind-versus-tide checks. The actual curve and hour-axis pixels remain visible below the captions. Screenshots, including 300 px / 130% / 85 px, were inspected.
- 41/41 focused unit tests and scoped ESLint passed. The new browser spec is included in the standard keyboard configuration.
- Receipts outside source: `work/tide-footer137-exact-geometry.json`, `work/validation137-tide-footer-final-browser.log`, `work/validation137-tide-footer-adaptive-focused-final.log`, `work/validation137-tide-footer-adaptive-lint.log`.

No whole-app TypeScript, production bundle, signed native build or physical-device result is claimed for this isolated patch. Those remain with the composed release validation. Failed early footer-only compact trials and initial new-test diagnostics are retained outside the repository; existing assertions were not relaxed.
