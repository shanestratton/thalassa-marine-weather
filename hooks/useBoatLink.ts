/**
 * useBoatLink — where this phone is, how the boat's data reaches it and how
 * fresh it is, as one snapshot every screen shares (services/boatLink).
 * Re-renders only when something the screens say changes.
 *
 * The service loads with the first screen that asks (131-01), set up or not.
 * Until it has, this is null and the screen says "Checking…"
 * (BOAT_LINK_CHECKING), never "No gateway" or "Not connected".
 */
import { useSyncExternalStore } from 'react';
import type { BoatLinkSnapshot } from '../services/boatLink/BoatLinkService';
import { loadedBoatLink, watchBoatLink } from '../services/boatLink/boatLinkGate';

const subscribe = (notify: () => void) => watchBoatLink(notify);
const getSnapshot = (): BoatLinkSnapshot | null => loadedBoatLink()?.getSnapshot() ?? null;

export function useBoatLink(): BoatLinkSnapshot | null {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
