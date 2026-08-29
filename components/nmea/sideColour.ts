/**
 * Port red, starboard green — one rule, one pair of colours.
 *
 * Lifted verbatim from SereneWindRose's pinned palette (--port / --stbd) so a
 * side reads in exactly the same two colours wherever it appears on the
 * Instrument Panel. On a boat these are read without thinking, and two
 * different reds on one screen would be worse than one.
 */
export const PORT_RED = '#ef5350';
export const STBD_GREEN = '#25b167';

/**
 * Below this, a reading is LEVEL rather than on a side.
 *
 * Taken from the heel readout on the Heading panel, which has carried this
 * dead-band and its reason since it was written: "an XDR that idles at 0.2°
 * would otherwise flip PORT/STBD every second and look broken." The same is
 * true of a rudder sensor sitting near centre, so both use it — a tile that
 * strobes red/green while the boat sits still reads as a fault.
 */
export const SIDE_DEAD_BAND = 0.3;

/**
 * The colour for a reading that has a side — rudder angle and heel.
 * Null means "no side", and the caller keeps its own tone.
 *
 * Pass the value AS DISPLAYED, already rounded to the digits on screen. The
 * colour must never contradict the number printed beside it: a rudder showing
 * 0.0 from a raw -0.04 is amidships to the eye and must not be painted red.
 *
 * Inside the dead-band there is no side. A rudder amidships is not "slightly
 * to port", and colouring it as though it were would put a red helm on a boat
 * steering straight.
 */
export function sideColour(shownValue: number | null | undefined, deadBand: number = SIDE_DEAD_BAND): string | null {
    if (shownValue === null || shownValue === undefined) return null;
    if (!Number.isFinite(shownValue) || Math.abs(shownValue) <= deadBand) return null;
    return shownValue < 0 ? PORT_RED : STBD_GREEN;
}
