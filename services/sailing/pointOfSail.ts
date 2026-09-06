/**
 * pointOfSail — the two calls any sailing boat wants from the wind angle.
 *
 * Shane, 2026-09-06: "show 'In Irons' so we know when to tack. it should
 * change by boat type of course. so my tayana, cant really sail any closer
 * than 45 degrees" — and "when we are running square, we should have the
 * option of sailing wing and wing".
 *
 * GENERIC ON PURPOSE, unlike services/sailing/sereneSailing.ts: nothing here
 * knows a sail or a rig. It knows one number about the boat — how close to the
 * true wind she will sail — and reads it from the vessel profile, with a
 * default by hull and rig when the skipper has not set it. Everything else is
 * geometry: degrees off the bow and whether she has way on.
 */
import type { VesselProfile } from '../../types/vessel';

export type PointOfSailState =
    | 'in-irons'
    | 'pinching'
    | 'close-hauled'
    | 'close-reach'
    | 'beam-reach'
    | 'broad-reach'
    | 'running-square';

export type PointOfSailLevel = 'good' | 'warning' | 'serious';

export interface PointOfSail {
    state: PointOfSailState;
    /** Short label for the strip. */
    label: string;
    /** One plain sentence about the helm. */
    detail: string;
    level: PointOfSailLevel;
    /** Degrees off the bow the verdict used: 0 head to wind, 180 dead square. */
    offBow: number;
    /** The angle she holds, from the profile. */
    closeHauledDeg: number;
    /** The answer is to put her about. */
    tack: boolean;
    /** Close enough to square that the pole comes out. */
    wingAndWing: boolean;
}

/** Inside this many degrees of her limit she is pinching, not in irons. */
export const PINCH_DEG = 5;
/** Within this of dead square (165°+) the running choice is wing and wing or gybing down. */
export const WING_AND_WING_DEG = 15;
/** Within this of dead square the wind can cross the stern unnoticed. */
export const DEAD_SQUARE_DEG = 8;
/** Below this she has no way on — in irons in the old sense, not merely too high. */
export const STALLED_KTS = 1.5;
export const DEFAULT_CLOSE_HAULED_DEG = 45;
/** Sanity bounds on the skipper's own number. */
export const CLOSE_HAULED_MIN_DEG = 25;
export const CLOSE_HAULED_MAX_DEG = 70;

type Pointing = Pick<VesselProfile, 'closeHauledTwa' | 'hullType' | 'riggingType'>;

/** Closest she will sail to the true wind: the skipper's number, else a default by hull and rig. */
export function closeHauledDegFor(vessel: Pointing | null | undefined): number {
    const set = vessel?.closeHauledTwa;
    if (typeof set === 'number' && Number.isFinite(set) && set >= CLOSE_HAULED_MIN_DEG && set <= CLOSE_HAULED_MAX_DEG) {
        return Math.round(set);
    }
    if (vessel?.hullType === 'catamaran' || vessel?.hullType === 'trimaran') return 50;
    switch (vessel?.riggingType) {
        case 'Sloop':
        case 'Solent':
            return 40;
        case 'Cutter':
        case 'Ketch':
        case 'Yawl':
        case 'Schooner':
        case 'Catboat':
            return 45;
        default:
            return DEFAULT_CLOSE_HAULED_DEG;
    }
}

/** Fold a where-the-wind-is-from angle (0–360 off the bow, either sign) to 0–180. */
export function offBowFrom(windFromDeg: number | null | undefined): number | null {
    if (typeof windFromDeg !== 'number' || !Number.isFinite(windFromDeg)) return null;
    const a = ((windFromDeg % 360) + 360) % 360;
    return a > 180 ? 360 - a : a;
}

export function pointOfSail(args: {
    windFromDeg: number | null | undefined;
    sogKts: number | null | undefined;
    closeHauledDeg: number;
}): PointOfSail | null {
    const off = offBowFrom(args.windFromDeg);
    if (off == null) return null;
    const ch = args.closeHauledDeg;
    const base = { offBow: off, closeHauledDeg: ch, tack: false, wingAndWing: false };

    if (off < ch - PINCH_DEG) {
        const stalled = typeof args.sogKts === 'number' && Number.isFinite(args.sogKts) && args.sogKts < STALLED_KTS;
        return {
            ...base,
            state: 'in-irons',
            label: 'In irons',
            level: 'serious',
            tack: !stalled,
            detail: stalled
                ? `No way on. Bear away, let her build speed, then come up to ${ch}°.`
                : `Too high for her — she will not sail closer than ${ch}°. Tack, or bear away.`,
        };
    }
    if (off < ch) {
        return {
            ...base,
            state: 'pinching',
            label: 'Pinching',
            level: 'warning',
            detail: `Bear away a few degrees — she holds ${ch}°.`,
        };
    }
    if (off < 60) {
        return { ...base, state: 'close-hauled', label: 'Close-hauled', level: 'good', detail: 'Hard on the wind.' };
    }
    if (off < 80)
        return { ...base, state: 'close-reach', label: 'Close reach', level: 'good', detail: 'Sailing free.' };
    if (off < 110) return { ...base, state: 'beam-reach', label: 'Beam reach', level: 'good', detail: 'Sailing free.' };
    if (off < 180 - WING_AND_WING_DEG) {
        return { ...base, state: 'broad-reach', label: 'Broad reach', level: 'good', detail: 'Sailing free.' };
    }
    const dead = off >= 180 - DEAD_SQUARE_DEG;
    return {
        ...base,
        state: 'running-square',
        label: dead ? 'Dead square' : 'Running square',
        level: dead ? 'warning' : 'good',
        wingAndWing: true,
        detail: dead
            ? 'Wing and wing with the preventer on — if the wind crosses the stern you are by the lee, and that is a gybe.'
            : 'Wing and wing: headsail poled out to windward, preventer on.',
    };
}
