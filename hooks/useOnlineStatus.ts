/**
 * useOnlineStatus — Reactive online/offline status hook.
 *
 * Listens to browser 'online'/'offline' events and returns
 * a boolean that re-renders when connectivity changes.
 */
import { useState, useEffect } from 'react';

export function useOnlineStatus(): boolean {
    const [isOnline, setIsOnline] = useState(
        typeof navigator !== 'undefined' ? navigator.onLine : true
    );

    useEffect(() => {
        const goOnline = () => setIsOnline(true);
        const goOffline = () => setIsOnline(false);
        window.addEventListener('online', goOnline);
        window.addEventListener('offline', goOffline);
        return () => {
            window.removeEventListener('online', goOnline);
            window.removeEventListener('offline', goOffline);
        };
    }, []);

    return isOnline;
}
