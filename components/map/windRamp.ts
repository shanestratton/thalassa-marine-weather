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
