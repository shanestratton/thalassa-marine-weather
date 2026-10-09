/**
 * The boat's live depth and wind in the anchor broadcast (126-05's `live`
 * block), read for the shore screen (126-03a). Pure.
 *
 * The Pi puts each value in only while it is fresh, with its own time. Ashore
 * the broadcast itself can then go quiet (the boat's link drops, the shore
 * phone sleeps), so the times are checked again here: a reading past two
 * minutes says how old it is, and past fifteen it is not shown at all. A
 * stale sounder figure must not read as "now".
 *
 * Missing or junk values read as unknown (null), never as 0: a real zero is a
 * reading, a dropped field is not.
 */
import type { PositionBroadcast } from './AnchorWatchSyncService';

export type AnchorLiveWire = NonNullable<PositionBroadcast['live']>;

/** Every key of the wire shape. The contract test pins it against the type and the Pi. */
export const ANCHOR_LIVE_KEYS = [
    'depthM',
    'depthReference',
    'depthAt',
    'twsKn',
    'twsAt',
    'twdDeg',
    'twdAt',
] as const satisfies readonly (keyof AnchorLiveWire)[];

/** A reading older than this shows its age. */
export const LIVE_SHOW_AGE_MS = 2 * 60_000;
/** A reading older than this is not shown at all. */
export const LIVE_MAX_AGE_MS = 15 * 60_000;
/** A clock this far ahead is still taken; further and the time is junk. */
const FUTURE_SKEW_MS = 30_000;

/** Below the keel may dip under zero (the keel in the mud), but not by more than a transducer's depth. */
const DEPTH_MIN_M = -5;
const DEPTH_MAX_M = 11_000;
const TWS_MAX_KN = 150;

export type LiveDepthReference = 'below-keel' | 'below-transducer' | 'below-surface';

export interface LiveReading {
    value: number;
    at: number;
    ageMs: number;
}

export interface AnchorLiveConditions {
    depth: (LiveReading & { reference: LiveDepthReference | null }) | null;
    tws: LiveReading | null;
    twd: LiveReading | null;
}

const REFERENCES = new Map<unknown, LiveDepthReference>([
    ['below-keel', 'below-keel'],
    ['below-transducer', 'below-transducer'],
    // The Pi's readDepth says 'below-waterline'.
    ['below-waterline', 'below-surface'],
    ['below-surface', 'below-surface'],
]);

function reading(
    block: Record<string, unknown>,
    valueKey: keyof AnchorLiveWire,
    atKey: keyof AnchorLiveWire,
    min: number,
    max: number,
    now: number,
): LiveReading | null {
    const value = block[valueKey];
    const at = block[atKey];
    if (typeof value !== 'number' || !(value >= min && value <= max)) return null;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
    if (at > now + FUTURE_SKEW_MS || now - at > LIVE_MAX_AGE_MS) return null;
    return { value, at, ageMs: Math.max(0, now - at) };
}

/** The live block, bounded and aged. Anything not a plain object reads as nothing known. */
export function readAnchorLiveConditions(live: unknown, now: number): AnchorLiveConditions {
    if (!live || typeof live !== 'object' || Array.isArray(live)) return { depth: null, tws: null, twd: null };
    const block = live as Record<string, unknown>;
    const depth = reading(block, 'depthM', 'depthAt', DEPTH_MIN_M, DEPTH_MAX_M, now);
    const twd = reading(block, 'twdDeg', 'twdAt', 0, 360, now);
    return {
        depth: depth && { ...depth, reference: REFERENCES.get(block.depthReference) ?? null },
        tws: reading(block, 'twsKn', 'twsAt', 0, TWS_MAX_KN, now),
        twd: twd && { ...twd, value: twd.value % 360 },
    };
}

/** "5 min ago" past LIVE_SHOW_AGE_MS; nothing for a reading that is current. */
export function liveAgeWords(ageMs: number): string | null {
    return ageMs > LIVE_SHOW_AGE_MS ? `${Math.floor(ageMs / 60_000)} min ago` : null;
}
