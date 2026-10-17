import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { parseWeatherWatchNotice } from '../../utils/weatherWatch';
interface BriefingPin {
    boatId: string;
    revision: string;
    scope: AuthIdentityScope;
    expiresAt: number;
    positionRevision: string;
}
let pending: BriefingPin | null = null;
const listeners = new Set<() => void>();
/** A fixed own-vessel handoff. No URL, coordinates or provider data from a push are trusted. */
export function pinWeatherBriefing(
    data: Readonly<Record<string, unknown>>,
    scope = getAuthIdentityScope(),
    now = Date.now(),
): boolean {
    const notice = parseWeatherWatchNotice(data, now);
    if (
        !scope.userId ||
        !isAuthIdentityScopeCurrent(scope) ||
        notice?.feature !== 'morning' ||
        !notice.positionRevision
    )
        return false;
    pending = {
        boatId: notice.boatId,
        revision: notice.revision,
        scope,
        expiresAt: notice.expiresAt,
        positionRevision: notice.positionRevision,
    };
    listeners.forEach((notify) => notify());
    return true;
}
export function getWeatherBriefingPin(): BriefingPin | null {
    return pending && isAuthIdentityScopeCurrent(pending.scope) && pending.expiresAt > Date.now() ? pending : null;
}
export function subscribeWeatherBriefingPin(notify: () => void): () => void {
    listeners.add(notify);
    return () => {
        listeners.delete(notify);
    };
}
export function takeWeatherBriefingPin(now = Date.now()): BriefingPin | null {
    const result = pending;
    pending = null;
    listeners.forEach((notify) => notify());
    return result && isAuthIdentityScopeCurrent(result.scope) && result.expiresAt > now ? result : null;
}
subscribeAuthIdentityScope(() => {
    pending = null;
    listeners.forEach((notify) => notify());
});
