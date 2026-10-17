import { useEffect, useState, useSyncExternalStore } from 'react';
import {
    loadPrivateComfort,
    personalComfortPreference,
    privateComfortSnapshot,
    subscribePrivateComfort,
} from '../services/comfort/privateComfort';
/** Private RAM lease only. No report/identity becomes a worker dependency. */
export function usePersonalComfort() {
    const snapshot = useSyncExternalStore(subscribePrivateComfort, privateComfortSnapshot, () => null);
    const [, tick] = useState(0);
    useEffect(() => {
        const refresh = () => {
            tick((value) => value + 1);
            if (document.visibilityState === 'visible') void loadPrivateComfort();
        };
        refresh();
        const timer = setInterval(refresh, 15000);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [snapshot?.boatId, snapshot?.revision]);
    return personalComfortPreference();
}
