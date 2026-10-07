/**
 * The tracer's Save, minus the screen: which name a save lands under, whether
 * it would overwrite a stored route, whether that overwrite is allowed, and
 * the chain bookkeeping that follows a persisted save.
 *
 * Lifted out of MapHub.saveCurrentTrace (2026-10-07) so the return-trip tests
 * drive the exact sequence a tap drives — name collision, "Overwrite?" arm,
 * the reversal refusal, saveTrace, the leg-1 retro badge and the forward heal
 * — instead of a hand-copied imitation of it. MapHub keeps everything that is
 * about the screen and the account: the release gate, the empty-name prompt,
 * the flash, the logbook mirror.
 */
import {
    destNameFromRouteName,
    healTripChain,
    retroBadgeFirstLeg,
    saveTrace,
    withLegBadge,
    type NextLegSeed,
    type SavedTrace,
    type TracePoint,
} from './routeTracer';
import type { TraceVerification } from './traceVerification';
import { legInSlot, overwriteBlockReason } from './tripReverse';

export type TraceSaveDecision =
    /** Refused outright — say why and put the cursor in the name box. */
    | { kind: 'refuse'; finalName: string; existing: SavedTrace; reason: string }
    /** Same name as a stored route: the first tap only arms "Overwrite?". */
    | { kind: 'confirm-overwrite'; finalName: string; existing: SavedTrace }
    | {
          kind: 'save';
          finalName: string;
          /** The stored route this save replaces in place (same id). */
          existing?: SavedTrace;
          /** Chain fields for a leg plotted from a locked start. */
          chain?: { tripId: string; legOrdinal: number; destName?: string };
      };

export function decideTraceSave(input: {
    name: string;
    points: readonly TracePoint[];
    anchor: NextLegSeed | null;
    savedTraces: readonly SavedTrace[];
    /** Id the previous tap armed for overwrite, if any. */
    overwriteArm: string | null;
    followedIds?: ReadonlySet<string>;
}): TraceSaveDecision {
    const { anchor } = input;
    const trimmed = input.name.trim();
    // Chained leg (Shane 2026-07-17): the stored name carries the ordinal
    // badge — "woorim - timbuktu" saves as "woorim - timbuktu (2nd Leg)".
    // withLegBadge strips any existing badge first, so re-saves never stack.
    const finalName = anchor ? withLegBadge(trimmed, anchor.ordinal) : trimmed;
    const wanted = finalName.toLowerCase();
    // Saving under an EXISTING route's name updates that route in place —
    // same id locally and on the account (Shane 2026-07-15), asked first.
    const named = wanted ? input.savedTraces.filter((trace) => trace.name.trim().toLowerCase() === wanted) : [];
    // Two rows can share a name: a trip's leg 1 earns its "(1st Leg)" badge
    // after the fact, and a separator-less name ("Bay run") reverses to
    // itself. "Overwrite?" against the first match could then replace a leg
    // of the OTHER trip with this line (2026-10-07 review). A chained leg
    // knows its own slot; any other draft cannot tell which row it means.
    const inThisSlot = anchor ? named.filter((trace) => legInSlot([trace], anchor) !== null) : [];
    const existing = named.length > 1 && inThisSlot.length === 1 ? inThisSlot[0] : named[0];
    if (named.length > 1 && inThisSlot.length !== 1) {
        return {
            kind: 'refuse',
            finalName,
            existing,
            reason: `${named.length} saved routes are called "${finalName}" — give this one its own name`,
        };
    }
    if (existing) {
        const reason = overwriteBlockReason(existing, input.points, { anchor, followedIds: input.followedIds });
        if (reason) return { kind: 'refuse', finalName, existing, reason };
        if (input.overwriteArm !== existing.id) return { kind: 'confirm-overwrite', finalName, existing };
    } else if (anchor) {
        // A chained draft keeps its locked start after Save. Saving it again
        // under a NEW name must not add a second leg N to the trip: the
        // passage rollup would jump between the two, and healTripChain would
        // drag leg N+1's start to whichever saved last.
        const occupant = legInSlot(input.savedTraces, anchor);
        if (occupant) {
            return {
                kind: 'refuse',
                finalName,
                existing: occupant,
                reason: `Leg ${anchor.ordinal} of this trip is already saved as "${occupant.name}" — keep that name to update it`,
            };
        }
    }
    return {
        kind: 'save',
        finalName,
        ...(existing ? { existing } : {}),
        ...(anchor
            ? {
                  chain: {
                      tripId: anchor.tripId,
                      legOrdinal: anchor.ordinal,
                      destName: destNameFromRouteName(finalName) ?? undefined,
                  },
              }
            : {}),
    };
}

/**
 * Persist a 'save' decision: the row itself, then — only once it stuck — the
 * trip becomes real at leg 2 (leg 1 retro-earns its badge) and an arrival edit
 * ripples into the next leg's locked start.
 */
export function commitTraceSave(
    decision: Extract<TraceSaveDecision, { kind: 'save' }>,
    points: readonly TracePoint[],
    verification?: TraceVerification,
): {
    trace: SavedTrace;
    persisted: boolean;
    cloud: ReturnType<typeof saveTrace>['cloud'];
    retro: SavedTrace | null;
    healed: string | null;
} {
    const { trace, persisted, cloud } = saveTrace(decision.finalName, points, {
        ...(decision.existing ? { overwriteId: decision.existing.id } : {}),
        ...(decision.chain ?? {}),
        ...(verification ? { verification } : {}),
    });
    const retro = persisted && decision.chain ? retroBadgeFirstLeg(decision.chain.tripId) : null;
    const healed = persisted ? healTripChain(trace) : null;
    return { trace, persisted, cloud, retro, healed };
}
