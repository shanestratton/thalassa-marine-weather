/**
 * Back to the Boat Binder from a page it opened (131-B12; binder audit BH-10).
 *
 * The binder is a screen inside the Vessel page, so a binder page's Back goes
 * to 'vessel' and the Vessel page reopens the binder from a mark the binder
 * left as it opened the page. The mark was a bare '1' that stayed until the
 * Vessel page next opened: leave Ship's Stores by the tab bar instead of Back,
 * and the next tap on the Vessel tab, however much later, landed in the
 * Binder. Now the mark names the page the binder opened, and the Vessel page
 * reopens the binder only when it has come straight back from that page. It
 * is spent either way.
 *
 * Kept per account in sessionStorage (authScopedStorageKey), as before.
 * Storage can be unavailable: then Back simply lands on Vessel.
 */
import { authScopedStorageKey } from '../../services/authIdentityScope';

const RETURN_KEY = 'thalassa_boat_binder_return';

/** The binder is opening `page`: Back from it returns to the binder. */
export function markBinderReturn(page: string): void {
    try {
        sessionStorage.setItem(authScopedStorageKey(RETURN_KEY), page);
    } catch {
        /* navigation still works when session storage is unavailable */
    }
}

/** The page the binder last opened, if its mark is still there. */
function markedPage(): string | null {
    try {
        return sessionStorage.getItem(authScopedStorageKey(RETURN_KEY));
    } catch {
        return null;
    }
}

function forgetBinderReturn(): void {
    try {
        sessionStorage.removeItem(authScopedStorageKey(RETURN_KEY));
    } catch {
        /* nothing to forget without storage */
    }
}

/**
 * The Vessel page, as it opens: reopen the binder? Only when it has come
 * straight back (`arrivedFrom`, the view it was entered from) from the page
 * the binder opened. The mark is spent either way, so a leftover never sends
 * a later visit to the binder.
 */
export function takeBinderReturn(arrivedFrom: string | null | undefined): boolean {
    const page = markedPage();
    forgetBinderReturn();
    return !!page && page === arrivedFrom;
}

/**
 * A binder page, as it opens: did the binder open it just now, so Back goes
 * to the binder? Opened another way (Plan's Import GPX), a mark left from an
 * earlier visit is forgotten, so Back lands on Vessel as its crumb says.
 */
export function openedFromBinder(page: string, arrivedFrom: string | null | undefined): boolean {
    if (markedPage() !== page) return false;
    if (arrivedFrom === 'vessel') return true;
    forgetBinderReturn();
    return false;
}
