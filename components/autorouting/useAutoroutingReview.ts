import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutoroutingTrialRoute } from '../../types/autorouting';
import { reviewAutoroutingProposal, type TrialRouteReview } from '../../services/autoroutingReview';
import { getRegistryFingerprint, subscribe } from '../../services/enc/EncCellMetadata';
import { autoroutingProposalGeometryKey } from '../../services/autoroutingProposalEvidence';

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
        const fingerprint = getRegistryFingerprint();
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
        const unsubscribe = subscribe(() => {
            if (!current() || getRegistryFingerprint() === fingerprint) return;
            controller.abort();
            // Display hydration is not proof of full-route coverage. Discard
            // old colours and offer a cold recheck against the updated library.
            setState(tagged({ phase: 'stale', legs: empty }));
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
            if (active.current === controller) active.current = null;
            unsubscribe();
        };
    }, [route, draftM, draftAssumed, geometryKey, vesselProfileKey, validDraft, attempt]);
    const stop = useCallback(() => {
        active.current?.abort();
        setState((current) => (current ? { ...current, review: { ...current.review, phase: 'stopped' } } : null));
    }, []);
    const recheck = useCallback(() => {
        // Invalidate immediately; an old progress callback must not win the
        // interval between the click and the next effect's cleanup.
        active.current?.abort();
        active.current = null;
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
