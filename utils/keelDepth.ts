/**
 * The one depth rule: what a sounder's reading leaves under the keel.
 *
 * The Instrument Panel's shoaling trend (components/nmea/depthTrend.ts, which
 * re-exports this under the same name) and the under-way shoal alarm
 * (services/underway/underwayRule.ts, build 126) both use this function, so
 * they can never disagree. It lives here, on its own, so the alarm's lazy
 * chunk does not carry the Instrument Panel's sailing brain with it.
 *
 * The only boat figure it needs is the DRAFT (Shane 2026-09-29: "we should not
 * need the offset for the transducer. just the draft … lets not make it too
 * complicated for the punter"). A known transducer offset never reaches the
 * phone as an offset: the Pi and the NMEA path fold it into a 'below-keel'
 * reading first, so 'below-transducer' always means the offset is unknown.
 *
 * PURE.
 */
import type { NmeaDepthReference } from '../types/navigation';

/**
 * The offset to add to a depth to reach the keel.
 *   • below the keel: 0 — the sounder already says what is under her;
 *   • anything else (below the waterline, below the transducer, or a feed
 *     that does not say): minus the draft. For a transducer below the
 *     waterline that takes off a little more than it needs to, which errs
 *     the safe way and needs no figure a skipper would have to measure.
 */
export function keelOffsetFor(reference: NmeaDepthReference | null | undefined, draftM: number): number {
    if (reference === 'below-keel') return 0;
    return -Math.max(0, draftM);
}
