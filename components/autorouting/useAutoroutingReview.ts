import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutoroutingTrialRoute } from '../../types/autorouting';
import { reviewAutoroutingProposal, type TrialRouteReview } from '../../services/autoroutingReview';
import { getRegistryFingerprint, subscribe } from '../../services/enc/EncCellMetadata';
import { getHydrationProgress, subscribeHydration } from '../../services/enc/encHydrationProgress';
import { autoroutingProposalGeometryKey, autoroutingRegistryScope } from '../../services/autoroutingProposalEvidence';

/** After charts under the route change, how long they must be still before
 *  the review checks the route again by itself (cells land in waves). */
export const AUTO_RECHECK_QUIET_MS = 1_500;
/** Checks of one route it runs by itself after charts under it changed
 *  outside a download walk (a sync, an import) before it waits for Recheck
 *  ('stale'): a library that never settles is said, not chased. */
export const AUTO_RECHECK_MAX = 3;
/** A download walk (the map filling in charts round a fresh route) lands its
 *  cells in waves — one per 8 cells or 10 s — for as long as it runs: the
 *  review waits for the walk to end and checks once, and does that for this
 *  many walks at most (review, 2026-10-09: four waves used to spend the three
 *  checks above and park a fresh route at 'stale'). */
export const AUTO_RECHECK_WALKS_MAX = 10;

export function useAutoroutingReview(
    route: AutoroutingTrialRoute | null,
    draftM: number | undefined,
    draftAssumed = route?.vesselProfile?.draftStatus !== 'measured',
) {
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<{
        route: AutoroutingTrialRoute;
        draftM: number;
        draftAssumed: boolean;
        geometryKey: string;
        vesselProfileKey: string;
        attempt: number;
        review: TrialRouteReview;
    } | null>(null);
    const active = useRef<AbortController | null>(null);
    // Checks this route, draft and profile ran by themselves, after other
    // changes and after download walks (Recheck resets both).
    const auto = useRef<{ key: string; count: number; walks: number }>({ key: '', count: 0, walks: 0 });
    const validDraft = typeof draftM === 'number' && Number.isFinite(draftM) && draftM > 0;
    const geometryKey = route ? autoroutingProposalGeometryKey(route.coordinates) : '';
    const vesselProfileKey = JSON.stringify(route?.vesselProfile ?? null);
    useEffect(() => {
        if (!route || !validDraft) {
            active.current?.abort();
            active.current = null;
            setState(null);
            return;
        }
        const controller = new AbortController();
        active.current = controller;
        const current = () => active.current === controller && !controller.signal.aborted;
        const checkKey = `${route.id}|${geometryKey}|${draftM}|${draftAssumed}|${vesselProfileKey}`;
        if (auto.current.key !== checkKey) auto.current = { key: checkKey, count: 0, walks: 0 };
        // Package 125-06 (Shane's fresh Auto route, 2026-10-08: "Chart checks
        // stale"): bound to the charts round this route, not the whole
        // library — a chart synced or loaded anywhere else is not this route's.
        const scope = autoroutingRegistryScope(route.coordinates);
        const fingerprint = getRegistryFingerprint(scope);
        const tagged = (review: TrialRouteReview) => ({
            route,
            draftM,
            draftAssumed,
            geometryKey,
            vesselProfileKey,
            attempt,
            review: {
                ...review,
                basis: {
                    proposalId: route.id,
                    geometryKey,
                    draftM,
                    draftAssumed,
                    vesselProfileKey,
                    registryFingerprint: fingerprint,
                    checkedAt: new Date().toISOString(),
                },
            },
        });
        const empty = Array.from({ length: route.coordinates.length - 1 }, () => null);
        setState(tagged({ phase: 'checking', legs: empty }));
        // Display hydration is not proof of full-route coverage: when a chart
        // under the route changes while it is checked, or after — the map
        // loading detail round a fresh route, a sync, a cell the check itself
        // fetched — the old colours go, and the route is checked again by
        // itself once the charts are still (125-06: a fresh route said "Chart
        // checks stale" and waited for Recheck): after a download walk has
        // ended, however many waves it landed; after other changes, up to
        // AUTO_RECHECK_MAX times. One that never settles is said, and waits
        // for Recheck.
        let quiet: ReturnType<typeof setTimeout> | null = null;
        let changed = false;
        let walked = false;
        const walking = () => getHydrationProgress().remaining > 0;
        const recheckWhenStill = () => {
            if (quiet) clearTimeout(quiet);
            quiet = setTimeout(() => {
                quiet = null;
                // Mid-walk: its end calls again.
                if (active.current !== controller || walking()) return;
                if (walked) auto.current.walks++;
                else auto.current.count++;
                active.current = null;
                setAttempt((value) => value + 1);
            }, AUTO_RECHECK_QUIET_MS);
        };
        const unsubscribe = subscribe(() => {
            if (active.current !== controller || (!changed && getRegistryFingerprint(scope) === fingerprint)) return;
            controller.abort();
            const walk = walking();
            if (
                !changed &&
                (walk ? auto.current.walks >= AUTO_RECHECK_WALKS_MAX : auto.current.count >= AUTO_RECHECK_MAX)
            ) {
                setState(tagged({ phase: 'stale', legs: empty }));
                return;
            }
            if (!changed) setState(tagged({ phase: 'checking', legs: empty }));
            changed = true;
            walked ||= walk;
            recheckWhenStill();
        });
        const unsubscribeWalk = subscribeHydration((progress) => {
            if (changed && progress.remaining === 0 && active.current === controller) recheckWhenStill();
        });
        void reviewAutoroutingProposal(
            route,
            draftM,
            controller.signal,
            (review) => {
                if (current()) setState(tagged(review));
            },
            { draftAssumed },
        )
            .then((review) => {
                if (current()) setState(tagged(review));
            })
            .catch(() => {
                if (current()) setState(tagged({ phase: 'error', legs: empty }));
            });
        return () => {
            controller.abort();
            if (quiet) clearTimeout(quiet);
            if (active.current === controller) active.current = null;
            unsubscribe();
            unsubscribeWalk();
        };
    }, [route, draftM, draftAssumed, geometryKey, vesselProfileKey, validDraft, attempt]);
    const stop = useCallback(() => {
        active.current?.abort();
        // Stopped is the skipper's: no chart change starts it again.
        active.current = null;
        setState((current) => (current ? { ...current, review: { ...current.review, phase: 'stopped' } } : null));
    }, []);
    const recheck = useCallback(() => {
        // Invalidate immediately; an old progress callback must not win the
        // interval between the click and the next effect's cleanup.
        active.current?.abort();
        active.current = null;
        auto.current.count = 0;
        auto.current.walks = 0;
        setAttempt((value) => value + 1);
    }, []);
    // Effect cleanup is too late to protect the first render after a keel or
    // retry changes. Never paint old colours against a different check key.
    const review =
        validDraft &&
        state?.route === route &&
        state.draftM === draftM &&
        state.draftAssumed === draftAssumed &&
        state.geometryKey === geometryKey &&
        state.vesselProfileKey === vesselProfileKey &&
        state.attempt === attempt
            ? state.review
            : null;
    return { review, stop, recheck };
}
