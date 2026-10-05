/**
 * The seabed log's one hook into the NMEA hot path, and the one boot check.
 *
 * NmeaListenerService calls getSeabedSink() for every instrument sentence,
 * next to NmeaRateTracker.record: with seabed mapping off (the default) that
 * is one null check and nothing else. The capture module, loaded lazily only
 * when this phone is the boat's logger, installs the sink.
 */
import { authScopedStorageKey } from '../authIdentityScope';

export type SeabedSentenceSink = (type: string, parts: string[], receivedAtMs: number) => void;

let sink: SeabedSentenceSink | null = null;

export function setSeabedSink(next: SeabedSentenceSink | null): void {
    sink = next;
}

export function getSeabedSink(): SeabedSentenceSink | null {
    return sink;
}

/** Auth-scoped: a mate signing in on the boat tablet never inherits the owner's switch. */
export const SEABED_LOCAL_KEY = 'seabed_platform_v1';

/** Where this account's queue lives on the phone: Directory.Data/seabed/<account>/. */
export function seabedDir(userId: string): string {
    return `seabed/${userId.replace(/[^A-Za-z0-9-]/g, '')}`;
}

let purgeHook: ((userId: string) => Promise<void>) | null = null;

/** Set by the capture module once loaded, so a deletion also stops a capture that is running. */
export function setSeabedPurgeHook(fn: (userId: string) => Promise<void>): void {
    purgeHook = fn;
}

/**
 * Account deletion: this account's seabed queue on this device goes (queued
 * and held hours, open rows, set-aside batches). Never throws.
 */
export async function purgeSeabedForUser(userId: string): Promise<void> {
    try {
        if (purgeHook) return await purgeHook(userId);
        const { Directory, Filesystem } = await import('@capacitor/filesystem');
        await Filesystem.rmdir({ path: seabedDir(userId), directory: Directory.Data, recursive: true });
    } catch {
        // Nothing there, or no filesystem (web): nothing to remove.
    }
}

/** True when this account switched seabed mapping on, on this device's last word. Never throws. */
export function seabedLocallyEnabled(): boolean {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(SEABED_LOCAL_KEY));
        return !!raw && (JSON.parse(raw) as { enabled?: unknown }).enabled === true;
    } catch {
        return false;
    }
}
