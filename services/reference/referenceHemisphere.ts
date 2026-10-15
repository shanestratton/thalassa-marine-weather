/**
 * Which hemisphere the Skipper's Reference cards are written for (132-B23).
 *
 * The synoptic and cyclone cards follow the skipper: the boat's GPS position
 * when the app has one, else the place the forecast is for. Before either is
 * known the app's location is a placeholder (Brisbane, source 'initial'), not
 * the skipper's, so it decides nothing: the cards show the Southern
 * Hemisphere and say there is no position yet. The skipper can always pick
 * the other hemisphere on the card.
 */
import type { Hemisphere } from './skipperReferenceCards';

export interface KnownPlace {
    lat: number;
    name?: string;
    /** LocationStore's source: 'initial' is its placeholder, not a position. */
    source: string;
}

export interface ReferenceHemisphere {
    hemisphere: Hemisphere;
    /** Where it came from: the GPS, a chosen or forecast place, or nothing yet. */
    basis: 'gps' | 'place' | 'none';
    /** One plain line for the card, saying where it came from. */
    words: string;
}

export function hemisphereFromPlace(place: KnownPlace | null | undefined): ReferenceHemisphere {
    if (!place || place.source === 'initial' || !Number.isFinite(place.lat)) {
        return {
            hemisphere: 'south',
            basis: 'none',
            words: 'No position yet, so the Southern Hemisphere is shown. Pick yours.',
        };
    }
    const hemisphere: Hemisphere = place.lat < 0 ? 'south' : 'north';
    if (place.source === 'gps') return { hemisphere, basis: 'gps', words: 'Set from your GPS position.' };
    const name = place.name?.trim();
    return { hemisphere, basis: 'place', words: name ? `Set from ${name}.` : 'Set from your forecast location.' };
}

/** The line once the skipper has picked a hemisphere themselves. */
export const CHOSEN_HEMISPHERE_WORDS = 'Your pick, for this visit.';
