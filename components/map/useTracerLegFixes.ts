/**
 * useTracerLegFixes — "Fix this leg" and "Fix all", extracted from MapHub.
 *
 * The route report grades every leg, and a danger leg gets two ways out:
 * splice a micro-A* detour around whatever it hit, or acknowledge it and sail
 * anyway. This owns the splice half.
 *
 * Three things here are load-bearing and were each bought with a bug:
 *
 *   - legs are processed LAST-TO-FIRST, so splicing pins into leg 5 cannot
 *     invalidate the index of leg 2 while the loop is still running;
 *
 *   - the whole run works on ONE local pin array and writes state once at the
 *     end, so a multi-leg fix never chases stale state through re-renders;
 *
 *   - it is ASYNC because grading is WINDOWED. tracerCtxRef holds only the
 *     LAST build window, so a danger leg from an earlier window has to build
 *     a fresh context around ITSELF before the A* runs. Without that, every
 *     out-of-window fix false-failed with "No clean detour here" — the button
 *     looked broken precisely on the long routes that needed it most.
 *
 * The draft comes from the last GRADING pass, not from settings. The two can
 * differ, and a fix has to reason about the same keel the verdict was
 * computed against, or it will happily "fix" a leg into water the grader
 * would still have failed.
 */

import { useCallback } from 'react';
import {
    buildTracerContext,
    traceBboxPadded,
    fixLegOnGrid,
    type TracerContext,
    type TraceLegVerdict,
} from '../../services/routeTracer';

export interface TracerLegFixDeps {
    capturedCoords: { lat: number; lon: number }[];
    setCapturedCoords: (pins: { lat: number; lon: number }[]) => void;
    /** The keel the CURRENT verdicts were graded against — not settings. */
    gradedDraftRef: { current: { d: number; assumed: boolean } | null };
    tracerCtxFromLru: (pts: ReadonlyArray<{ lat: number; lon: number }>) => TracerContext | null;
    tracerCtxHold: (ctx: TracerContext) => void;
    legVerdicts: Array<TraceLegVerdict | null>;
    ackedLegs: Set<number>;
    /** -1 means "fixing all", any other index means that one leg. */
    setFixBusyLeg: (i: number | null) => void;
    flashTraceFeedback: (msg: string) => void;
}

export interface TracerLegFixes {
    onFixLeg: (i: number) => void;
    onFixAll: () => void;
}

export function useTracerLegFixes(deps: TracerLegFixDeps): TracerLegFixes {
    const {
        capturedCoords,
        setCapturedCoords,
        gradedDraftRef,
        tracerCtxFromLru,
        tracerCtxHold,
        legVerdicts,
        ackedLegs,
        setFixBusyLeg,
        flashTraceFeedback,
    } = deps;

    // Splice micro-A* detours for the given DANGER legs. Processed last-to-
    // first so earlier indices stay valid, on ONE local pin array so a
    // multi-fix doesn't chase stale state. Returns how many actually fixed.
    // ASYNC since windowed grading: tracerCtxRef holds only the LAST build
    // window, so a danger leg from an earlier window builds a fresh context
    // around ITSELF before the A* — otherwise every out-of-window fix
    // false-failed with "No clean detour here".
    const applyFixes = useCallback(
        async (legIdxs: number[]): Promise<{ fixed: number; added: number }> => {
            // Draft from the LAST GRADING PASS, not from settings — the two
            // can differ, and the fix has to reason about the same keel the
            // verdict was computed against. Fix buttons only exist once a
            // pass has graded, so the ref is always populated here.
            const draft = gradedDraftRef.current;
            if (!draft) return { fixed: 0, added: 0 };
            let pins = [...capturedCoords];
            let fixed = 0;
            for (const i of [...legIdxs].sort((x, y) => y - x)) {
                if (i < 0 || i + 1 >= pins.length) continue;
                let ctx = tracerCtxFromLru([pins[i], pins[i + 1]]);
                if (!ctx) {
                    try {
                        const built = await buildTracerContext(traceBboxPadded([pins[i], pins[i + 1]]), draft.d, {
                            draftAssumed: draft.assumed,
                        });
                        if (built.status === 'ready') {
                            ctx = built.ctx;
                            tracerCtxHold(built.ctx);
                        } else {
                            continue; // marks-only/no chart — nothing to A* on
                        }
                    } catch {
                        continue;
                    }
                }
                const detour = fixLegOnGrid(ctx, pins[i], pins[i + 1]);
                if (detour && detour.length >= 2) {
                    pins = [...pins.slice(0, i + 1), ...detour.slice(1, -1), ...pins.slice(i + 1)];
                    fixed++;
                }
            }
            if (fixed > 0) setCapturedCoords(pins);
            // `added` feeds the auto-route flash — "3 pins added" vs "the
            // straight shot was already the clean line".
            return { fixed, added: fixed > 0 ? pins.length - capturedCoords.length : 0 };
        },
        [capturedCoords, gradedDraftRef, tracerCtxFromLru, tracerCtxHold, setCapturedCoords],
    );

    const onFixLeg = useCallback(
        (i: number) => {
            setFixBusyLeg(i);
            // Yield a frame so the "Fixing…" state paints before the A*.
            setTimeout(() => {
                void applyFixes([i]).then(({ fixed }) => {
                    flashTraceFeedback(
                        fixed > 0 ? 'Leg fixed — re-checked' : 'No clean detour here — acknowledge or re-trace',
                    );
                    setFixBusyLeg(null);
                });
            }, 30);
        },
        [applyFixes, flashTraceFeedback, setFixBusyLeg],
    );

    const onFixAll = useCallback(() => {
        const dangers = legVerdicts
            .map((v, i) => (v?.grade === 'danger' && !ackedLegs.has(i) ? i : -1))
            .filter((i) => i >= 0);
        if (dangers.length === 0) return;
        setFixBusyLeg(-1);
        setTimeout(() => {
            void applyFixes(dangers).then(({ fixed }) => {
                flashTraceFeedback(
                    fixed === dangers.length
                        ? `All ${fixed} no-go legs fixed — re-checked`
                        : `${fixed}/${dangers.length} fixed — the rest need an acknowledge or a re-trace`,
                );
                setFixBusyLeg(null);
            });
        }, 30);
    }, [legVerdicts, ackedLegs, applyFixes, flashTraceFeedback, setFixBusyLeg]);

    // applyFixes stays internal — the two buttons are the whole surface.
    return { onFixLeg, onFixAll };
}
