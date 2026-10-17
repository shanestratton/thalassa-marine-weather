# 140-07: popup light rhythms

Light popups now include a small source-colour SVG lamp. The existing ENC
`lightRows` path covers standalone lights, light vessels/floats and light
information folded into a mark popup. OpenSeaMap popups render each numbered
light independently, with at most eight previews. Chart layers do not animate.

The shared parser reads ENC LITCHR/SIGGRP/SIGPER/COLOUR/SIGSEQ through the existing
case-tolerant reader and OpenSeaMap light character/group/period/colour/sequence
tags. It retains the supplied complete period. Explicit valid sequences retain
their individual durations; isophase has equal light/dark halves. Other supported
simple characters use an **Illustrative rhythm** caption because the source
character, group and period do not specify actual pulse widths. All moving
previews say they are not synchronised to the real light. Fixed lights stay on.

Flashing has less light than dark, occulting has more light than dark, and long
flashes last at least two seconds. Quick illustrations use nominal 60/120/240
flashes per minute within a declared group and remain labelled illustrative.
Ungrouped quick periods that do not establish that cadence are unavailable.
Compound or Morse patterns need an explicit valid sequence. Alternating colours
and fixed-plus-flash intensity patterns remain unavailable rather than silently
choosing a colour or fabricating intensity. Existing textual attributes remain.

Unknown/ambiguous colours, unsupported characters, invalid groups, invalid or
missing periods, malformed sequences and inconsistent sequence totals show
**Rhythm preview unavailable**. Sequence strings are capped at 256 characters
and 32 intervals, groups at 12 signals, and moving periods at 0.25–120 seconds.
Only validated numeric values and palette constants enter the generated markup.

CSS handles the animation. `prefers-reduced-motion: reduce` removes it live and
shows a steady swatch with a static caption. There are no JavaScript timers or
listeners to retain after a popup closes. Existing popup removal/unmount removes
the CSS animation and its stylesheet.

The source definitions distinguish the full cycle from its individual intervals
and define the light, dark and occulting conventions:
[OpenSeaMap light schema](https://wiki.openstreetmap.org/wiki/Seamarks/Lights),
[IHO S-57 light attributes and encoding](https://iho.int/iho_pubs/standard/S-57Ed3.1/S-57%20Appendix%20B.1%20Annex%20A%20UOC%20Edition%204.1.0_Jan18_EN.pdf).

Validation on this isolated source packet:

- 63 focused cases across `LightRhythm`, existing ENC popup logic and seamark
  light icons pass. Scoped ESLint passes.
- Four actual Chrome/WebKit cases pass at 300/375 px and 130% text. Real CSS
  animation sampling confirms the declared 10-second two-flash cycle, source
  red/green colours, the four-second OSM isophase period, live reduced-motion
  changes, initial reduced motion, complete teardown and unknown-data refusal.
  There are no unfiltered page errors or external requests.
- Evidence: workspace `work/validation14007-light-unit-source-final.log`,
  `work/validation14007-light-lint-final.log`,
  `work/validation14007-light-browser-final.log`, and
  `work/light140-browser-final`. The fixture contains invented attributes and
  coordinates; it uses production popup renderers without a provider or map.

This packet has no whole-app compiler, production bundle, native build,
deployment or device claim. Those belong to the later composed 140 release.
