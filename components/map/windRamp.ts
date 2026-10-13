/**
 * windRamp — the single source of truth for wind particle colours.
 *
 * Lives in its own module so the legend (ThalassaHelixControl) can share the
 * band table with the renderer (MapboxVelocityOverlay) without importing that
 * component's leaflet-velocity payload. Before this, the ramp was hand-mirrored
 * in three places and drifted.
 *
 * ── Why the bands are built this way ──
 *
 * leaflet-velocity slices 0..maxVelocity into exactly `colorScale.length` equal
 * buckets and picks with `floor(len * v / max)`, where v is RAW m/s from the GFS
 * grid. The old ramp was 6 colours over maxVelocity 40 m/s — i.e. 13-KNOT bands
 * running to 78 kt, so everything from a drifter to a 25-knot reefing breeze
 * drew in one of two near-identical muted tones and the reds were reserved for
 * a cyclone core. That, not the hues, is why the field looked washed out.
 *
 * The fix is to emit ONE-KNOT buckets with repeated hexes. Decoupling the
 * visible band edges from the bucket width means the edges are a free choice,
 * so they can land on the thresholds a skipper actually steers by — including
 * the true Beaufort F8 gale line at 34 kt, which no uniform 5-kt scheme hits.
 *
 * WIND_HOT_BIAS shrinks each bucket a hair so every edge falls just BELOW its
 * round knot (the reef band opens at 19.957 kt). Borderline particles therefore
 * bias to the HOTTER colour — the safe direction for a go/no-go read.
 *
 * Colours are chosen to survive BOTH basemaps: the ENC chart paints deep water
 * pure white (encDepthStyle b50plus '#ffffff') and satellite is near-black, and
 * the library composites additively ('lighter') at ~0.873 alpha, which pushes
 * pale stops further toward white. Hence saturated, mid-to-low luminance stops
 * throughout — no pastels. The 20 / 30 / 34 kt boundaries are cross-family hue
 * flips so they survive protanopia and deuteranopia.
 */

export interface WindBand {
    /** Upper bound in knots (exclusive). */
    toKt: number;
    hex: string;
    label: string;
}

/** Low → high. The legend renders these bottom-to-top in the same order. */
export const WIND_BANDS: WindBand[] = [
    { toKt: 5, hex: '#124a9e', label: 'Drifter' },
    { toKt: 10, hex: '#1583ec', label: 'Light air' },
    { toKt: 15, hex: '#00a6cc', label: 'Pleasant' },
    { toKt: 20, hex: '#10a06b', label: 'Working breeze' },
    { toKt: 25, hex: '#ee7a0b', label: 'Reef' },
    { toKt: 30, hex: '#e63020', label: 'Heavy reef' },
    { toKt: 34, hex: '#ee2b74', label: 'Near gale' },
    { toKt: 40, hex: '#cf35bd', label: 'Gale (F8)' },
    { toKt: 48, hex: '#a24ef0', label: 'Strong gale' },
    { toKt: 60, hex: '#6d28d9', label: 'Storm force' },
];

/**
 * The band a speed falls in. Use this for anything that colours a DISCRETE
 * thing — a speed label, a chip, a legend row — rather than windColorForKt(),
 * which re-implements the particle renderer's m/s bucketing and exists to be
 * testable against it. Both agree on the edges; this one says what it means.
 */
export function windBandForKt(kt: number): WindBand {
    if (!Number.isFinite(kt) || kt <= 0) return WIND_BANDS[0];
    return WIND_BANDS.find((b) => kt < b.toKt) ?? WIND_BANDS[WIND_BANDS.length - 1];
}

const KT_TO_MS = 1852 / 3600;

/** Bucket count = ceiling in knots, i.e. one bucket per knot. */
export const WIND_TOP_KT = 60;

/** <1 so each band edge lands just below its round knot — see the header. */
export const WIND_HOT_BIAS = 0.99785;

/** Bucket k carries the colour of the band containing knot k. */
export const WIND_COLORS: string[] = Array.from(
    { length: WIND_TOP_KT },
    (_, k) => (WIND_BANDS.find((b) => k < b.toKt) ?? WIND_BANDS[WIND_BANDS.length - 1]).hex,
);

/** 30.8003 m/s. Anything above ~59.87 kt clamps to the top band. */
export const WIND_MAX_MS = WIND_TOP_KT * KT_TO_MS * WIND_HOT_BIAS;

/**
 * The colour the renderer will draw for a given wind speed — a faithful
 * re-implementation of the library's getColorIndex, so the band edges can be
 * unit-tested without standing up a map.
 */
export function windColorForKt(kt: number): string {
    const v = kt * KT_TO_MS;
    if (!Number.isFinite(v) || v <= 0) return WIND_COLORS[0];
    if (v >= WIND_MAX_MS) return WIND_COLORS[WIND_COLORS.length - 1];
    const i = Math.floor((WIND_COLORS.length * v) / WIND_MAX_MS);
    return WIND_COLORS[Math.min(Math.max(i, 0), WIND_COLORS.length - 1)];
}

/**
 * Legend gradient with HARD stops. The renderer buckets, so a smooth blend
 * would advertise an interpolation that never happens — each band gets a flat
 * span proportional to its knot width.
 */
export const WIND_GRADIENT = `linear-gradient(to top, ${WIND_BANDS.map((b, i) => {
    const fromKt = i === 0 ? 0 : WIND_BANDS[i - 1].toKt;
    const pct = (kt: number) => ((kt / WIND_TOP_KT) * 100).toFixed(2);
    return `${b.hex} ${pct(fromKt)}%, ${b.hex} ${pct(b.toKt)}%`;
}).join(', ')})`;

/**
 * The streaks' own palette (Shane 2026-10-06: "the wind is impossible to see
 * in shore, maybe we could make it white???"). Below the 20 kt reef line the
 * streaks are white: the 0-20 kt blues and green were specks on Relief's blue
 * lagoon. From the reef line up they keep the warning hues, which stand out on
 * blue water and are what a skipper needs flagged. Same one-knot buckets as
 * WIND_COLORS, so the band edges do not move. Chips and labels keep
 * WIND_BANDS' colours (getWindColor).
 */
export const WIND_PARTICLE_WHITE_BELOW_KT = 20;
export const WIND_PARTICLE_WHITE = '#ffffff';
export const WIND_PARTICLE_COLORS: string[] = WIND_COLORS.map((hex, k) =>
    k < WIND_PARTICLE_WHITE_BELOW_KT ? WIND_PARTICLE_WHITE : hex,
);

/**
 * The streaks on the desk's LIGHT base (127-DESKMAP-b). White measured
 * 1.3-2.0:1 on Light's pale sea and the reef orange 1.4-2.2:1: the field would
 * vanish on the base the desk opens on. Same buckets; below 20 kt a slate ink
 * (7:1 on every Light colour), from the reef line up each band's own hue
 * family, dark enough to read on every Light water and land colour.
 *
 * DRAWN NORMALLY (128-LIGHT; Shane 2026-10-13: "yes to all of your questions
 * for 128"). The field strokes Light's ink with source-over, not
 * leaflet-velocity's additive 'lighter' (MapboxVelocityOverlay drawInkOver,
 * CloseInWindLayer), so an ink lands as itself, mixed with the chart under
 * it: at the stroke's 0.882 where a streak is whole, and at about 0.6 of it
 * in the soft cores a Retina screen shows of the CSS-pixel canvas (0.61-0.69
 * measured in WebKit at DPR 2 for 22-52 kt, 0.57 for the slower sub-20 kt
 * streaks, 2026-10-13). Every rule here holds for that colour as drawn on
 * Light's open sea, not for the ink (tests/windRamp.test.ts):
 *  - the 26 kt red is a pure red, so its soft edges stay red (127's maroon,
 *    #650b19, turned them mauve in WebKit);
 *  - neighbours stay ΔE2000 ≥ 10 apart at the stroke and in a Retina core,
 *    for normal, deutan and protan vision;
 *  - each warm band keeps its hue family and, as drawn, a colour, not a grey;
 *  - every ink stands off the sea by ΔE2000 ≥ 28 in a Retina core;
 *  - every ink but the reef orange reaches 3.25:1 in a Retina core and 3.6:1
 *    at the stroke on every Light colour; the slate 7:1 as ink.
 * THE REEF ORANGE (20-25 kt) IS LIGHT ON PURPOSE (128-LIGHT review). To a
 * colour-blind eye a red and an orange differ only in lightness, and a red
 * that stays red to its soft edges cannot be dark, so the orange is the
 * lighter of the pair. A dark orange turns brown-grey on the pale sea (this
 * package's first draft, #451501, came out a grey-brown beside the slate) or
 * merges with the red. The trade: the orange has the lowest luminance contrast
 * of the palette, 2.4:1 in a Retina core and 3.5:1 at the stroke on the open
 * sea as modelled (its streak cores measured 2.7:1 in WebKit at DPR 2 and
 * 3.2:1 in Chromium at 1x, 2026-10-13, where the other inks reach 3:1). It
 * still stands off the sea as far as the other inks do, because
 * orange on pale blue is a step in colour as well as in lightness. The slate
 * is a shade darker than 127's #1e2b38 (still the label ink): drawn normally,
 * 127's slate cores fell to 3.2:1. (reliefBase's LIGHT_PALETTE gives the
 * grounds; browser-tests/desk-wind-layout.spec.ts holds the pixels.)
 */
const LIGHT_HUES: Record<string, string> = {
    '#ee7a0b': '#ab3700',
    '#e63020': '#920000',
    '#ee2b74': '#741030',
    '#cf35bd': '#780064',
    '#a24ef0': '#4408d0',
    '#6d28d9': '#440c64',
};
export const WIND_PARTICLE_COLORS_LIGHT: string[] = WIND_COLORS.map((hex, k) =>
    k < WIND_PARTICLE_WHITE_BELOW_KT ? '#141c26' : LIGHT_HUES[hex],
);
/** Which streak palette: 'light' for a pale base (the desk's Light by day), 'dark' everywhere else. */
export type WindPalette = 'light' | 'dark';
const particleColors = (palette: WindPalette) =>
    palette === 'light' ? WIND_PARTICLE_COLORS_LIGHT : WIND_PARTICLE_COLORS;

/**
 * The streak colour for one speed, bucketed exactly as windColorForKt — for
 * the close-in renderer (CloseInWindLayer), which draws the whole view in the
 * one local wind rather than handing leaflet-velocity a colour scale.
 */
export function windParticleColorForKt(kt: number, palette: WindPalette = 'dark'): string {
    const colors = particleColors(palette);
    const v = kt * KT_TO_MS;
    if (!Number.isFinite(v) || v <= 0) return colors[0];
    if (v >= WIND_MAX_MS) return colors[colors.length - 1];
    return colors[Math.min(Math.floor((colors.length * v) / WIND_MAX_MS), colors.length - 1)];
}

/** The legend for the streaks, hard stops at the band edges, bottom-up: the palette's own inks. */
const particleGradient = (palette: WindPalette) =>
    `linear-gradient(to top, ${WIND_BANDS.map((b, i) => {
        const fromKt = i === 0 ? 0 : WIND_BANDS[i - 1].toKt;
        const pct = (kt: number) => ((kt / WIND_TOP_KT) * 100).toFixed(2);
        const hex = particleColors(palette)[fromKt];
        return `${hex} ${pct(fromKt)}%, ${hex} ${pct(b.toKt)}%`;
    }).join(', ')})`;
/** WIND_GRADIENT with the sub-20 kt bands white. */
export const WIND_PARTICLE_GRADIENT = particleGradient('dark');
export const WIND_PARTICLE_GRADIENT_LIGHT = particleGradient('light');
