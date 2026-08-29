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
 * The colour for a reading that has a side — rudder angle today, heel if it
 * ever wants one. Null means "no side", and the caller keeps its own tone.
 *
 * Pass the value AS DISPLAYED, already rounded to the digits on screen. The
 * colour must never contradict the number printed beside it: a rudder showing
 * 0.0 from a raw -0.04 is amidships to the eye and must not be painted red.
 *
 * Exactly zero is neither side. A rudder amidships is not "slightly to port",
 * and colouring it as though it were would put a red helm on a boat steering
 * straight.
 */
export function sideColour(shownValue: number | null | undefined): string | null {
    if (shownValue === null || shownValue === undefined) return null;
    if (!Number.isFinite(shownValue) || shownValue === 0) return null;
    return shownValue < 0 ? PORT_RED : STBD_GREEN;
}
