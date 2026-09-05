/**
 * creditsStrip — the one place on the Obs chart where data credits live.
 *
 * Shane, 2026-09-06: "audit all of the credits for the obs page layers. put
 * them all in the same spot below the drop down box at the top middle of the
 * screen." Before this, each credit picked its own corner — RainViewer bottom
 * right above the scrubber, Copernicus bottom left above the legend — and each
 * fought the working controls for the same few pixels.
 *
 * The strip is centred under the basemap dropdown (MapBaseSelector: top =
 * inset + 8px, trigger h-12 → bottom at inset + 56px), starting 6px below it.
 * Credits stack downward in fixed slots so a credit never jumps when another
 * appears: slot 0 is the RainViewer pill (~28px), slot 1 starts 30px lower.
 *
 * Wording is each licence's minimum, unchanged here: the words are the
 * licence's business, the position is ours.
 */

/** Distance from the safe-area top to the strip's first slot. */
export const CREDITS_STRIP_TOP_PX = 62;

/** Height reserved per single-line credit slot. */
export const CREDITS_SLOT_PX = 30;

/** Inline `top` for a credit in the strip, `offsetPx` below the first slot. */
export function creditsStripTop(offsetPx = 0): string {
    return `calc(env(safe-area-inset-top) + ${CREDITS_STRIP_TOP_PX + offsetPx}px)`;
}

/** Centred under the dropdown; z sits under the dropdown's own menu (z-710). */
export const CREDITS_STRIP_POSITION_CLASS = 'absolute left-1/2 -translate-x-1/2';
