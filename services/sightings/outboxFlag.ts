/**
 * A one-line hint that this account has sightings waiting to send, kept
 * OUTSIDE the IndexedDB outbox so app start can ask it for free. Without it
 * nothing loads the Sightings code after a relaunch: three whales logged
 * offline, then iOS killing the WebView, would wait until the skipper next
 * opened Sightings, and the crew's live feed would never get them.
 *
 * The store sets it when it saves a record that is waiting; the outbox clears
 * it once nothing is. App start (hooks/useAppBootstrap.ts) reads it and only
 * then lazy-loads the outbox. The key ends '::user:<id>' (encoded), so the
 * account-deletion sweep of web storage removes it with the account's other
 * keys. A nicety: a lost or blocked localStorage only means the outbox waits
 * for the next time Sightings opens, as before.
 */

const PREFIX = 'thalassa_sightings_outbox_v1';

function key(userId: string): string {
    return `${PREFIX}::${encodeURIComponent(`user:${userId}`)}`;
}

export function flagSightingsOutbox(userId: string): void {
    try {
        localStorage.setItem(key(userId), '1');
    } catch {
        /* a nicety */
    }
}

export function clearSightingsOutboxFlag(userId: string): void {
    try {
        localStorage.removeItem(key(userId));
    } catch {
        /* a nicety */
    }
}

export function sightingsOutboxFlagged(userId: string): boolean {
    try {
        return localStorage.getItem(key(userId)) === '1';
    } catch {
        return false;
    }
}
