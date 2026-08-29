/**
 * Wind panel slot assignment — which instrument owns the hero bezel.
 *
 * The Wind panel carries three instruments: a TWS dial and the apparent and
 * true wind roses. Which one deserves the big slot depends on how you sail —
 * "some people prefer" (Shane 2026-08-29) — so a long press on either rose
 * swaps it into the hero bezel and sends the dial down to the slot it left.
 *
 * Pure, so the rules can be tested without mounting the panel. The panel owns
 * the gestures and the storage; this module owns the arithmetic.
 */

export type WindHeroId = 'tws' | 'awa' | 'twa';

export const WIND_HERO_STORAGE_KEY = 'glass_wind_hero';

/** The bottom pair in their resting order, left to right. */
export const WIND_BOTTOM_DEFAULT: readonly WindHeroId[] = ['awa', 'twa'];

export const WIND_CAPTIONS: Record<WindHeroId, string> = {
    tws: 'True Wind Speed',
    awa: 'Apparent',
    twa: 'True',
};

export function isWindHeroId(value: string | null | undefined): value is WindHeroId {
    return value === 'tws' || value === 'awa' || value === 'twa';
}

/**
 * The bottom pair is DERIVED from the hero, never stored alongside it.
 *
 * Storing both would allow a state where the same rose appears twice, or one
 * vanishes entirely — a panel showing two "Apparent" roses is worse than
 * useless on a boat, because the two would be read as apparent and true.
 * Deriving makes that unrepresentable: whichever rose went up, the dial takes
 * the slot it vacated, and each instrument appears exactly once.
 */
export function windBottomFor(hero: WindHeroId): WindHeroId[] {
    return WIND_BOTTOM_DEFAULT.map((id) => (id === hero ? 'tws' : id));
}

/** TWS bands, shared by the dial's zone arcs AND its accent colour, so the
 *  needle can never disagree with the band it is standing in. */
export const TWS_ZONES: { from: number; to: number; color: string }[] = [
    { from: 0, to: 15, color: '#22c55e' },
    { from: 15, to: 25, color: '#eab308' },
    { from: 25, to: 40, color: '#f97316' },
    { from: 40, to: 60, color: '#ef4444' },
];

/**
 * The needle, its glow and the value arc take the colour of the band the
 * reading sits in, rather than one fixed accent (Shane 2026-08-29). At a
 * glance the colour alone answers "is this a lot of wind" without reading the
 * number.
 *
 * `to` is exclusive, so a value landing exactly on a boundary belongs to the
 * band above it: 15.0 kt is the start of yellow, not the top of green.
 *
 * Anything at or beyond the last band STAYS in the last band. A gust past the
 * dial's maximum must not fall through to the first zone — that failure would
 * paint 60+ kt green, which is the one reading that must never look calm.
 */
export function zoneColorFor(
    value: number | null | undefined,
    zones: { from: number; to: number; color: string }[],
    fallback: string,
): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
    if (zones.length === 0) return fallback;
    for (const zone of zones) {
        if (value >= zone.from && value < zone.to) return zone.color;
    }
    const last = zones[zones.length - 1];
    return value >= last.to ? last.color : zones[0].color;
}
