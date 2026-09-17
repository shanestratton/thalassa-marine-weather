/**
 * passageHudFormat — the words and numbers on the passage strip, pure.
 *
 * The strip is 76 px wide, so everything it says is a number or a short tag;
 * the full sentence behind each tag goes in the element's title and
 * aria-label. Kept out of the component so the honesty rules can be tested
 * against the REAL GPS status resolver rather than hand-written fixtures —
 * the first two cuts of the GPS line were each "fixed" against a fixture the
 * resolver never produces, and each was still a constant in production.
 */
import type { DataFreshness, RemoteVia } from '../../services/NmeaStore';

export interface HudValue {
    value: number | null;
    freshness: DataFreshness;
}

export const DASH = '—';

export const fmtKnots = (m: HudValue): string =>
    m.value === null ? DASH : m.value < 10 ? m.value.toFixed(1) : String(Math.round(m.value));

export const fmtBearing = (m: HudValue): string =>
    m.value === null ? DASH : `${String(((Math.round(m.value) % 360) + 360) % 360).padStart(3, '0')}°`;

/** Apparent wind angle is signed, negative to port. */
export const fmtRelative = (m: HudValue): string =>
    m.value === null ? DASH : `${Math.abs(Math.round(m.value))}°${m.value < 0 ? 'P' : 'S'}`;

export const fmtNm = (v: number): string => (v < 10 ? v.toFixed(1) : String(Math.round(v)));

export type FixSource = 'boat' | 'boat-cloud' | 'phone' | 'phone-old';

export function fixSourceTag(source: FixSource, ageMin: number): string {
    if (source === 'boat') return 'BOAT GPS';
    if (source === 'boat-cloud') return 'BOAT · CLOUD';
    if (source === 'phone') return 'PHONE GPS';
    return `PHONE ${ageMin}M`;
}

export function fixSourceSentence(source: FixSource, ageMin: number): string {
    if (source === 'boat') return 'By the boat’s GPS';
    if (source === 'boat-cloud') return 'By the boat’s GPS, relayed through the cloud — it does not steer this phone';
    if (source === 'phone') return 'By this phone’s GPS';
    return `By this phone’s GPS, last fix ${ageMin} min ago`;
}

export function laneTag(via: RemoteVia | null, connected: boolean, anyValue: boolean): string {
    if (via === 'lan') return 'VIA PI';
    if (via === 'cloud') return 'CLOUD';
    if (connected && anyValue) return 'GATEWAY';
    return 'NO INSTR';
}

export function laneSentence(via: RemoteVia | null, connected: boolean, anyValue: boolean): string {
    if (via === 'lan') return 'Boat instruments, via the Pi';
    if (via === 'cloud') return 'Boat instruments, through the cloud — not steering';
    if (connected && anyValue) return 'Boat instruments, from the gateway';
    return 'No boat instruments';
}

/**
 * The GPS receiver's STATE as a tag, from the resolver's `detail`.
 *
 * The resolver writes the state as one ' · ' clause among others (device
 * name first on some branches; quality, satellites and HDOP appended on the
 * vessel branches), so the state is found by what it SAYS, not by its place.
 * Returns null for a detail this does not recognise — a missing tag is honest,
 * a wrong one is not.
 */
export function gpsStateTag(detail: string): string | null {
    for (const clause of detail.split(' · ').map((c) => c.trim())) {
        if (/^Live via /.test(clause)) return 'GPS LIVE';
        const old = /^Last GPS sentence (\S+) ago/.exec(clause);
        if (old) return `GPS ${old[1].toUpperCase()} OLD`;
        if (/^Through the cloud/.test(clause)) return 'GPS · CLOUD';
        if (/^Waiting for GPS position/.test(clause)) return 'GPS WAITING';
        if (/^Supplying position/.test(clause)) return 'EXT GPS LIVE';
        if (/^iPhone GPS (currently )?in use/.test(clause)) return 'PHONE GPS';
        if (/^No position yet/.test(clause)) return 'NO GPS FIX';
    }
    return null;
}
