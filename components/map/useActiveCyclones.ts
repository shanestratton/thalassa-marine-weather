import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '../../utils/createLogger';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';

const log = createLogger('useActiveCyclones');
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Fetches the active-cyclone catalogue only while a chart feature needs it.
 * The cyclone/squall layers already own their visual lifecycles; this hook
 * owns the picker catalogue and avoids spending data, battery, and CPU every
 * time a skipper merely opens the normal chart.
 */
export function useActiveCyclones(enabled: boolean) {
    const [cyclones, setCyclones] = useState<ActiveCyclone[]>([]);
    const mountedRef = useRef(true);
    const inflightRef = useRef<Promise<ActiveCyclone[]> | null>(null);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const refresh = useCallback(async (): Promise<ActiveCyclone[]> => {
        if (inflightRef.current) return inflightRef.current;

        const request = (async () => {
            try {
                const { fetchActiveCyclones } = await import('../../services/weather/CycloneTrackingService');
                return await fetchActiveCyclones();
            } catch (error) {
                log.warn('Could not load active cyclones', error);
                return [];
            }
        })();
        inflightRef.current = request;
        void request.finally(() => {
            if (inflightRef.current === request) inflightRef.current = null;
        });

        const result = await request;
        if (mountedRef.current) setCyclones(result);
        return result;
    }, []);

    useEffect(() => {
        if (!enabled) return;
        void refresh();
        const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [enabled, refresh]);

    return { cyclones, refresh };
}
