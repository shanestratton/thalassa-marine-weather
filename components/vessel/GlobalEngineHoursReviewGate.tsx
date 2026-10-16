import React, { Suspense, lazy, useEffect, useState } from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { validEngineRunCounter, type EngineRunCounter } from '../../services/shiplog/engineRunCounter';
import {
    ENGINE_HOURS_REVIEW_EVENT,
    requestEngineHoursReview,
    type EngineHoursOffer,
} from '../../services/shiplog/engineHoursOffer';

const Sheet = lazy(() => import('./EngineHoursReviewSheet'));
const EVENT = ENGINE_HOURS_REVIEW_EVENT;
export function GlobalEngineHoursReviewGate() {
    const [offer, setOffer] = useState<EngineHoursOffer | null>(null);
    useEffect(() => {
        const receive = (event: Event) => {
            const candidate = (event as CustomEvent<EngineHoursOffer>).detail;
            if (
                !candidate?.scope ||
                !isAuthIdentityScopeCurrent(candidate.scope) ||
                !candidate.scope.userId ||
                !candidate.counter ||
                !validEngineRunCounter(candidate.counter, candidate.counter.voyageId) ||
                !candidate.counter.ended
            )
                return;
            setOffer(candidate);
        };
        window.addEventListener(EVENT, receive);
        const unsubscribe = subscribeAuthIdentityScope(() => setOffer(null));
        return () => {
            window.removeEventListener(EVENT, receive);
            unsubscribe();
        };
    }, []);
    if (!offer || !isAuthIdentityScopeCurrent(offer.scope)) return null;
    return (
        <Suspense fallback={null}>
            <Sheet offer={offer} onClose={() => setOffer(null)} />
        </Suspense>
    );
}

/** Reopen the latest ended record without importing ShipLogService into Maintenance's boot graph. */
export async function reviewLatestEndedEngineRun(): Promise<void> {
    const scope = getAuthIdentityScope();
    const { loadTrackingState } = await import('../../services/shiplog/TrackingStateStore');
    const state = await loadTrackingState(scope);
    const counter: EngineRunCounter | undefined = state?.engineRun;
    if (
        isAuthIdentityScopeCurrent(scope) &&
        counter &&
        counter.ended &&
        validEngineRunCounter(counter, counter.voyageId)
    ) {
        if (isAuthIdentityScopeCurrent(scope)) requestEngineHoursReview(counter, state?.boatId);
    }
}
