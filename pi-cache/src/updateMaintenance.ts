import fs from 'node:fs';
import path from 'node:path';

export const updateMaintenancePath = (cacheDir: string): string => path.join(cacheDir, 'update5-maintenance.json');
/** A stale or unreadable sentinel still blocks a new watch until an operator removes it. */
export function updateMaintenanceActive(cacheDir: string): boolean {
    try {
        fs.lstatSync(updateMaintenancePath(cacheDir));
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
}
/** Loopback installer status only: no assignment, session code, location or credential. */
export function updateMaintenanceStatus(
    cacheDir: string,
    watch: { running: boolean; sessionExpiresAt: number | null },
) {
    return {
        version: 1,
        maintenance: updateMaintenanceActive(cacheDir),
        anchorRunning: watch.running,
        sessionExpiresAt: watch.sessionExpiresAt,
        observedAt: Date.now(),
    };
}
