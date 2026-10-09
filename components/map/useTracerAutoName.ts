/**
 * useTracerAutoName — the tracer names a route from its first and last pins
 * ("Newport - Scarborough", Shane 2026-07-16), live as the route grows, with
 * coordinates when no place is nearby. Pulled out of MapHub (126-16a) so the
 * rule that matters for trip legs can be driven in a test beside the real
 * Save decision.
 *
 * Auto-naming is ACTIVE while the name box is empty or still holding the last
 * auto value. The moment the skipper types their own name it stops touching
 * the box. lastAutoNameRef is what tells "we named it" from "the skipper named
 * it"; the draft restores it alongside the name.
 *
 * A TRIP'S LEG OPENED IN ITS PLACE IS NEVER RENAMED (126-16a review). Its name
 * is its identity in the trip: Save looks for the row in this slot under the
 * name on screen. Re-arming the namer there turned "Mackay - Whitsundays (3rd
 * Leg)" into "Mackay - Airlie Beach" on the first pin drag, and Save then
 * refused, because slot 3 was taken by a row of the old name. Leg 1 and a lone
 * route open free and are re-armed as before (Shane 2026-07-28: Moreton Bay →
 * Lady Musgrave retitles when its destination is dragged).
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { NextLegSeed, TracePoint } from '../../services/routeTracer';

export interface TracerAutoNameDeps {
    coordCaptureMode: boolean;
    capturedCoords: ReadonlyArray<TracePoint>;
    traceName: string;
    legAnchor: NextLegSeed | null;
    lastAutoNameRef: MutableRefObject<string>;
    setTraceName: Dispatch<SetStateAction<string>>;
}

/** Debounce: a burst of pin drops costs one geocode pass. */
export const AUTO_NAME_DEBOUNCE_MS = 800;

export function useTracerAutoName(deps: TracerAutoNameDeps): void {
    const { coordCaptureMode, capturedCoords, traceName, legAnchor, lastAutoNameRef, setTraceName } = deps;
    useEffect(() => {
        if (!coordCaptureMode || capturedCoords.length === 0) return;
        const isAuto = traceName === '' || traceName === lastAutoNameRef.current;
        if (!isAuto) return;
        // A chained leg has no destination until one is traced. With just the
        // locked start, first === last and this would name it "Newport - Newport";
        // leaving the "Newport - " prefill alone is the honest state.
        if (legAnchor && capturedCoords.length < 2) return;
        const first = capturedCoords[0];
        const last = capturedCoords[capturedCoords.length - 1];
        let current = true;
        // Debounced (and the helper caches on a ~1 km grid anyway).
        const t = window.setTimeout(() => {
            void import('../../services/routeAutoName').then(async ({ autoRouteName, placeLabelFor }) => {
                // CHAINED LEG: the FROM half is the previous leg's recorded arrival
                // name and is authoritative. Re-geocoding the anchor can return a
                // different label for the same spot — "Scarborough" for the pin the
                // previous leg called "Newport" — which would contradict both the
                // locked-start badge and the leg it chains from. Only the
                // destination is looked up.
                const name = legAnchor
                    ? `${legAnchor.fromName} - ${await placeLabelFor(last)}`
                    : await autoRouteName(first, last);
                // A slow outbound geocode must not overwrite the return-trip
                // name after Reverse, a route load, or an endpoint edit.
                if (!current) return;
                setTraceName((cur) => {
                    // The skipper typed while we were geocoding — theirs wins.
                    if (cur !== '' && cur !== lastAutoNameRef.current) return cur;
                    lastAutoNameRef.current = name;
                    return name;
                });
            });
        }, AUTO_NAME_DEBOUNCE_MS);
        return () => {
            current = false;
            window.clearTimeout(t);
        };
    }, [capturedCoords, coordCaptureMode, traceName, legAnchor, lastAutoNameRef, setTraceName]);
}

/**
 * After a saved route is opened: re-arm auto-naming for a name that WE
 * generated, so dragging the destination retitles it. Without this the
 * restored name looks hand-typed and is never updated. A trip's leg opened in
 * its slot is the exception: its name stays put (see the file comment), so
 * the namer is switched off for it, synchronously, before any pin can move.
 */
export function rearmAutoNameForOpenedRoute(
    lastAutoNameRef: MutableRefObject<string>,
    name: string,
    slot: NextLegSeed | null,
): void {
    if (slot) {
        lastAutoNameRef.current = '';
        return;
    }
    void import('../../services/routeAutoName').then(({ looksAutoNamed }) => {
        if (looksAutoNamed(name)) lastAutoNameRef.current = name;
    });
}
