import { useEffect, useState } from 'react';
import { CloudTelemetryService, type CloudTelemetry } from '../services/CloudTelemetryService';

/**
 * The boat's cloud snapshot, kept polling while the caller is mounted.
 * `piPrimary` is true while the Pi's snapshot is under a minute old.
 */
export function useCloudTelemetry(): { latest: CloudTelemetry | null; piPrimary: boolean } {
    const [latest, setLatest] = useState<CloudTelemetry | null>(() => CloudTelemetryService.getLatest());
    useEffect(() => {
        CloudTelemetryService.retain();
        const unsub = CloudTelemetryService.subscribe(setLatest);
        return () => {
            unsub();
            CloudTelemetryService.release();
        };
    }, []);
    return { latest, piPrimary: CloudTelemetryService.piIsPrimary() };
}
