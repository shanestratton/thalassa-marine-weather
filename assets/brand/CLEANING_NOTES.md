# Thalassa Brand Asset Cleaning Notes

## Source

`Thalassa.svg` from Vectorizer.AI, traced from an Upscayl-4x-enlarged
PNG of the Gemini Pro-generated original concept.

## Cleaning pipeline applied (2026-05-17)

The raw Vectorizer.AI output was 155 KB, 163 paths, 13 distinct
colours — too noisy for production. Two passes:

### Pass 1: Colour mapping

Mapped 13 detected colour variants → 3 brand-exact hexes:

- 3 dark-navy variants (`#0e1116`, `#12171f`, `#10141b`) → `#0F172A`
- 6 cyan/teal variants (`#3e8791`, `#569fa9`, `#264c54`, `#345b64`,
  `#9fc3c8`, `#abcfd4`) → `#5EEAD4`
- 2 grey anti-aliasing strokes (`#87888b`, `#898b8f`) → `#0F172A`
- White (`#ffffff`) preserved as `#FFFFFF`

### Pass 2: Strip outline-tracing group

Vectorizer.AI emits the trace as TWO layers: filled shapes + a separate
stroke group drawing seams between fill regions. The stroke group (91
paths, all with `fill="none"`) was anti-aliasing artefact. Surgically
removed via regex.

### Pass 3: SVGO `--multipass --precision=2`

Standard optimisation: merge adjacent paths with the same fill,
collapse precision, remove metadata. Cuts from 72 paths → 16.

## Final asset

- `full-lockup-dark.svg` — 61 KB, 16 paths, 3 colours
- viewBox `0 0 1786 1761` (close to square; slightly tall because
  the upscale source had wordmark below the mark)

## Still to produce

- `mark.svg` — full mark without the wordmark
- `mark-simplified.svg` — compass rose cardinal points only, no wave
- `wordmark.svg` — "THALASSA" + "MARINE DATA & NAVIGATION" alone
- `full-lockup-light.svg` — same lockup but with dark text on white bg
- `favicon-*.png` — 16/32/48/192/512 px raster exports
- `mark-1024.png` — iOS app icon (no transparency, no rounded corners)
