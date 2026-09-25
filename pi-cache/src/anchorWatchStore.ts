import fs from 'node:fs';
import path from 'node:path';
import type { AnchorWatchAssignment } from './anchorBroadcaster.js';

export interface SavedAnchorWatch {
    assignment: AnchorWatchAssignment;
    relayId: string;
    expiresAt: number;
    sessionExpiresAt: number;
}

export interface AnchorWatchStore {
    read(): SavedAnchorWatch | null;
    save(watch: SavedAnchorWatch): void;
    clear(): void;
}

/** Only the assignment and cloud-confirmed finite lease survive reboot.
 * No positions, alarm history, credentials or user sessions are persisted. */
export function fileAnchorWatchStore(cacheDir: string): AnchorWatchStore {
    const filename = path.join(cacheDir, 'anchor-watch.json');
    return {
        read() {
            try {
                const info = fs.lstatSync(filename);
                if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024) return null;
                const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as SavedAnchorWatch;
                const a = value.assignment;
                if (
                    !a ||
                    !/^[A-Za-z0-9]{12}$/.test(a.sessionCode) ||
                    !/^[A-Za-z0-9_-]{16,128}$/.test(value.relayId) ||
                    !Number.isFinite(a.anchorLat) ||
                    Math.abs(a.anchorLat) > 90 ||
                    !Number.isFinite(a.anchorLon) ||
                    Math.abs(a.anchorLon) > 180 ||
                    !Number.isFinite(a.swingRadius) ||
                    a.swingRadius < 5 ||
                    a.swingRadius > 5_000 ||
                    !Number.isFinite(value.expiresAt) ||
                    !Number.isFinite(value.sessionExpiresAt) ||
                    value.expiresAt > value.sessionExpiresAt
                )
                    return null;
                return value;
            } catch {
                return null;
            }
        },
        save(watch) {
            fs.mkdirSync(cacheDir, { recursive: true });
            // Explicit fields keep accidental credential/position additions out.
            const { assignment, relayId, expiresAt, sessionExpiresAt } = watch;
            const temporary = `${filename}.tmp`;
            fs.writeFileSync(temporary, JSON.stringify({ assignment, relayId, expiresAt, sessionExpiresAt }), {
                mode: 0o600,
            });
            fs.renameSync(temporary, filename);
        },
        clear() {
            fs.rmSync(filename, { force: true });
        },
    };
}
