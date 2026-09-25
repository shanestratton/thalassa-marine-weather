import { authScopedStorageKey, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';

const KEY = 'thalassa_just_recording_v1';
export const JUST_RECORDING_CHOSEN_EVENT = 'thalassa:just-recording-chosen';

function readChoices(scope: AuthIdentityScope): string[] {
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(authScopedStorageKey(KEY, scope)) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(-100) : [];
    } catch {
        return [];
    }
}

/** A local UI answer, not permission to clear a route or modify a voyage. */
export function choseJustRecording(voyageId: string, scope: AuthIdentityScope): boolean {
    return readChoices(scope).includes(voyageId);
}

export function rememberJustRecording(voyageId: string, scope: AuthIdentityScope): void {
    if (!voyageId || !isAuthIdentityScopeCurrent(scope)) return;
    const choices = readChoices(scope).filter((id) => id !== voyageId);
    try {
        localStorage.setItem(authScopedStorageKey(KEY, scope), JSON.stringify([...choices, voyageId].slice(-100)));
    } catch {
        // LogPage's in-session guard still works when device storage is unavailable.
    }
    // A replacement Log instance may already be mounted while native start
    // resolves in the old instance. Retire its question immediately too.
    if (typeof window !== 'undefined') {
        window.dispatchEvent(
            new CustomEvent(JUST_RECORDING_CHOSEN_EVENT, {
                detail: { voyageId, ownerKey: scope.key },
            }),
        );
    }
}
