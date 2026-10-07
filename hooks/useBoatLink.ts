/**
 * useBoatLink — where this phone is, how the boat's data reaches it and how
 * fresh it is, as one snapshot every screen shares (services/boatLink).
 * Re-renders only when something the screens say changes.
 */
import { useSyncExternalStore } from 'react';
import { BoatLinkService, type BoatLinkSnapshot } from '../services/boatLink/BoatLinkService';

export function useBoatLink(): BoatLinkSnapshot {
    return useSyncExternalStore(BoatLinkService.subscribe, BoatLinkService.getSnapshot, BoatLinkService.getSnapshot);
}
