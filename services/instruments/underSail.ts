import { useSyncExternalStore } from 'react';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../authIdentityScope';
let confirmed: { identity: string; generation: number } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((cb) => cb());
subscribeAuthIdentityScope(() => {
    confirmed = null;
    emit();
});
export function confirmUnderSail(identity: string | null) {
    confirmed = identity ? { identity, generation: getAuthIdentityScope().generation } : null;
    emit();
}
export function isUnderSailConfirmed(identity: string | undefined) {
    return !!identity && confirmed?.identity === identity && confirmed.generation === getAuthIdentityScope().generation;
}
export function resetUnderSailForFeed(identity: string | undefined, engineRunning: boolean) {
    if (confirmed && (confirmed.identity !== identity || engineRunning)) {
        confirmed = null;
        emit();
    }
}
export function useUnderSailConfirmation(identity: string | undefined) {
    return useSyncExternalStore(
        (cb) => {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
        () => isUnderSailConfirmed(identity),
        () => false,
    );
}
