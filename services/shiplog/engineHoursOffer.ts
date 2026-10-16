/** Local UI event only. Ending a voyage never waits on a database, provider or UI chunk. */
import { getAuthIdentityScope, type AuthIdentityScope } from '../authIdentityScope';
import { engineRunSummary, validEngineRunCounter, type EngineRunCounter } from './engineRunCounter';
export const ENGINE_HOURS_REVIEW_EVENT = 'thalassa:engine-hours-review';
export interface EngineHoursOffer {
    scope: AuthIdentityScope;
    counter: EngineRunCounter;
    boatId?: string;
}
export function requestEngineHoursReview(counter: EngineRunCounter, boatId?: string): void {
    const scope = getAuthIdentityScope();
    if (
        !scope.userId ||
        !validEngineRunCounter(counter, counter.voyageId) ||
        !counter.ended ||
        engineRunSummary(counter).seconds === 0
    )
        return;
    window.dispatchEvent(
        new CustomEvent<EngineHoursOffer>(ENGINE_HOURS_REVIEW_EVENT, {
            detail: { scope, counter: { ...counter, rpm: counter.rpm ? { ...counter.rpm } : null }, boatId },
        }),
    );
}
