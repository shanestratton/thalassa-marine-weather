/**
 * "⇄ Plan the return trip" (Shane 2026-10-07): a NEW trip home, built one
 * checked leg at a time from the outbound legs reversed.
 *
 *  - start() opens return leg 1 — outbound leg K reversed — as an ordinary
 *    unlocked draft. It saves as a standalone route, and the trip becomes real
 *    when leg 2 is saved: the same day-sail rule as a hand-plotted trip.
 *  - After each Save, nextReturnLeg offers "Next return leg →". openNext()
 *    locks the next leg's first pin to the arrival just saved (nextLegSeed) and
 *    drops the next outbound leg in reversed (reversedLegForSlot).
 *  - The skipper can stop at any leg; what was saved stays.
 *
 * Every return leg goes through the tracer's own grading, release gate and
 * Save, so it is checked in THIS direction before it exists, and it gets its
 * own mirror, Passage Planning row and chain fields. The outbound rows are
 * only ever read — by id, at each step — so an edited source is honoured and
 * a deleted one ends the flow out loud. The cursor lives in the tracer draft
 * (useTraceDraft), which is why it survives a reload.
 */
import { useCallback, useMemo, useRef } from 'react';
import {
    displayRouteLabel,
    loadSavedTraces,
    nextLegSeed,
    type SavedTrace,
    type TracePoint,
} from '../../services/routeTracer';
import {
    describeReversalSource,
    distanceNM,
    findTripGroup,
    returnTripOrder,
    reversedCopyOf,
    reversedLegForSlot,
    tripName,
    type ReturnPlan,
} from '../../services/tripReverse';
import type { useTraceDraft } from './useTraceDraft';

type TraceDraft = Pick<ReturnType<typeof useTraceDraft>, 'returnPlan' | 'setReturnPlan' | 'openReversedLeg'>;

export interface ReturnTripProgress {
    /** The return leg on screen (or just saved), 1-based. */
    leg: number;
    of: number;
    /** That leg has been saved and the next one can be opened. */
    saved: boolean;
}

export function useReturnTripFlow(draft: TraceDraft, options: { flash: (message: string) => void }) {
    const { returnPlan, setReturnPlan, openReversedLeg } = draft;
    // Taps and the tracer-open handler can run in a closure from an earlier
    // render; the cursor they act on must be the current one.
    const planRef = useRef<ReturnPlan | null>(returnPlan);
    planRef.current = returnPlan;
    const flashRef = useRef(options.flash);
    flashRef.current = options.flash;

    const stopQuietly = useCallback(() => {
        planRef.current = null;
        setReturnPlan(null);
    }, [setReturnPlan]);

    /** Open return leg 1: outbound leg `fromPosition` (default the last)
     *  reversed. Returns its pins for the camera, or null. */
    const start = useCallback(
        (tripId: string, fromPosition?: number): TracePoint[] | null => {
            const traces = loadSavedTraces();
            const group = findTripGroup(traces, tripId);
            const order = group ? returnTripOrder(group, fromPosition) : [];
            const first = group?.legs.find((leg) => leg.id === order[0]);
            if (!group || !first) {
                flashRef.current('That trip is no longer saved on this device');
                return null;
            }
            const copy = reversedCopyOf(first);
            const plan: ReturnPlan | null =
                order.length > 1
                    ? {
                          sourceTripId: group.key,
                          sourceLabel: tripName(group),
                          sourceLegIds: order,
                          nextIndex: 1,
                          chainFromId: null,
                      }
                    : null;
            const opened = openReversedLeg({
                points: copy.points,
                name: copy.name,
                legAnchor: null,
                reversedFrom: { label: displayRouteLabel(first), end: { ...copy.points[copy.points.length - 1] } },
                returnPlan: plan,
            });
            if (!opened) return null;
            planRef.current = plan;
            const unchanged = describeReversalSource(traces, first.points)?.unchanged;
            // openReversedLeg dropped any outbound departure; say so.
            flashRef.current(
                plan
                    ? `Return leg 1 of ${order.length} — set a departure for the trip home, check it in this direction, then save`
                    : `Reversed copy — ${unchanged ?? `${displayRouteLabel(first)} is unchanged`}. Set a departure for the trip home`,
            );
            return copy.points;
        },
        [openReversedLeg],
    );

    /** A persisted Save. Returns a phrase for the save flash when the trip
     *  home is complete. Re-saving the same leg is harmless. */
    const onSaved = useCallback(
        (trace: SavedTrace): string | null => {
            const plan = planRef.current;
            if (!plan) return null;
            if (plan.nextIndex >= plan.sourceLegIds.length) {
                stopQuietly();
                return `return trip saved — ${plan.sourceLegIds.length} legs`;
            }
            const next = { ...plan, chainFromId: trace.id };
            planRef.current = next;
            setReturnPlan(next);
            return null;
        },
        [setReturnPlan, stopQuietly],
    );

    /** "Next return leg →". Returns the opened pins, or null. */
    const openNext = useCallback((): TracePoint[] | null => {
        const plan = planRef.current;
        if (!plan?.chainFromId) return null;
        const traces = loadSavedTraces();
        const previous = traces.find((trace) => trace.id === plan.chainFromId);
        const outboundOrdinal = plan.sourceLegIds.length - plan.nextIndex;
        if (!previous) {
            stopQuietly();
            flashRef.current('The last return leg you saved is gone — return trip stopped');
            return null;
        }
        const source = traces.find((trace) => trace.id === plan.sourceLegIds[plan.nextIndex]);
        if (!source) {
            stopQuietly();
            flashRef.current(`Leg ${outboundOrdinal} of ${plan.sourceLabel} was deleted — return trip stopped`);
            return null;
        }
        const seed = nextLegSeed(previous);
        if (!seed) {
            stopQuietly();
            return null;
        }
        const advanced: ReturnPlan = { ...plan, nextIndex: plan.nextIndex + 1, chainFromId: null };
        const slot = reversedLegForSlot(source, seed.anchor);
        if (!slot) {
            // Never bridge the gap with an invented segment: lock the start,
            // leave the leg for the skipper to plot, and say why.
            const prefill = `${seed.fromName} - `;
            openReversedLeg({
                points: [seed.anchor],
                name: prefill,
                autoName: prefill,
                legAnchor: seed,
                reversedFrom: null,
                returnPlan: advanced,
            });
            planRef.current = advanced;
            const gap = distanceNM(source.points[source.points.length - 1], seed.anchor);
            flashRef.current(
                `Leg ${outboundOrdinal} of ${plan.sourceLabel} no longer ends where this return leg starts (${gap.toFixed(1)} NM apart) — plot this leg by hand`,
            );
            return [seed.anchor];
        }
        openReversedLeg({
            points: slot.points,
            name: slot.name,
            legAnchor: seed,
            reversedFrom: { label: slot.sourceLabel, end: { ...slot.points[slot.points.length - 1] } },
            returnPlan: advanced,
        });
        planRef.current = advanced;
        flashRef.current(
            `Return leg ${advanced.nextIndex} of ${plan.sourceLegIds.length} — check it in this direction, then save`,
        );
        return slot.points;
    }, [openReversedLeg, stopQuietly]);

    const stop = useCallback(() => {
        stopQuietly();
        flashRef.current('Return trip stopped — the legs you saved are kept');
    }, [stopQuietly]);

    const progress = useMemo<ReturnTripProgress | null>(
        () =>
            returnPlan
                ? { leg: returnPlan.nextIndex, of: returnPlan.sourceLegIds.length, saved: !!returnPlan.chainFromId }
                : null,
        [returnPlan],
    );
    const nextReturnLeg = useMemo(
        () =>
            returnPlan?.chainFromId && returnPlan.nextIndex < returnPlan.sourceLegIds.length
                ? { j: returnPlan.nextIndex + 1, k: returnPlan.sourceLegIds.length }
                : null,
        [returnPlan],
    );

    return { start, onSaved, openNext, stop, progress, nextReturnLeg };
}
