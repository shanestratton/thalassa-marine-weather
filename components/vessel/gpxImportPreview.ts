/**
 * What the GPX import preview tells the skipper, as plain functions (132-B21):
 * the duration from the file's own times, the notes on anything the import
 * had to decide for him, why a save failed, and coordinates that read right
 * either side of the 180° line. Kept out of the page so each is testable.
 */
import type { GpxTrackImport } from '../../services/gpxService';

/** Elapsed time between the first and last time the file gives, or 'Unknown' when it gives none. */
export function formatImportDuration(firstTimeMs: number | null, lastTimeMs: number | null): string {
    if (firstTimeMs === null || lastTimeMs === null) return 'Unknown';
    const durationMs = lastTimeMs - firstTimeMs;
    const hours = Math.floor(durationMs / 3600000);
    const minutes = Math.floor((durationMs % 3600000) / 60000);
    return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m` : 'Unknown';
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The notes under the preview: everything the import decided that the file
 * didn't say. Each is one plain sentence or two; none claims more than the
 * file holds.
 */
export function gpxImportNotes(parsed: GpxTrackImport): string[] {
    const notes: string[] = [];

    if (parsed.savedTrackPoints < parsed.trackPoints) {
        const stride = Math.ceil(parsed.trackPoints / Math.max(1, parsed.savedTrackPoints));
        notes.push(
            `Long track: ${parsed.trackPoints.toLocaleString()} points. The log keeps about 1 in every ${stride} ` +
                `(${parsed.savedTrackPoints.toLocaleString()} points), so it saves quickly. Distance and times ` +
                `come from all ${parsed.trackPoints.toLocaleString()}.`,
        );
    }

    if (parsed.fallbackDate) {
        const what = parsed.trackPoints > 0 ? 'The track has' : 'The waypoints have';
        const when =
            parsed.fallbackDate.source === 'file'
                ? `on ${new Date(parsed.fallbackDate.timeMs).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                  })}, the date saved in the file`
                : "under today's date";
        notes.push(`${what} no times, so speed and duration are unknown. It will be logged ${when}.`);
    } else if (parsed.untimedTrackPoints > 0) {
        notes.push(
            `${plural(parsed.untimedTrackPoints, 'track point has', 'track points have')} no time. ` +
                (parsed.untimedTrackPoints === 1
                    ? 'It is placed between the timed points either side, and gets no speed.'
                    : 'They are placed between the timed points either side, and get no speed.'),
        );
    }

    if (parsed.untimedWaypoints > 0 && parsed.trackPoints > 0) {
        notes.push(
            `${plural(parsed.untimedWaypoints, 'waypoint has', 'waypoints have')} no time. ` +
                `${parsed.untimedWaypoints === 1 ? 'It is' : 'Each is'} logged at the moment the track passed closest to it.`,
        );
    }

    if (parsed.segments > 1) {
        notes.push(
            `${parsed.segments.toLocaleString()} track segments. The gaps between them don't count as distance sailed.`,
        );
    }

    if (parsed.skippedPoints > 0) {
        notes.push(
            `${plural(parsed.skippedPoints, 'point has', 'points have')} no usable position and will be left out.`,
        );
    }

    return notes;
}

export type ImportSaveFailure = 'signed-out' | 'offline' | 'timed-out' | 'account-changed' | 'unknown';

/**
 * Why a save failed, from the import's error and whether the phone is online.
 * The import's messages are its own (EntryCrud.importGPXVoyage); a fetch that
 * never left the phone reads 'Failed to fetch' in WebKit dev builds and
 * 'Load failed' on iOS.
 */
export function classifyImportSaveFailure(err: unknown, online: boolean): ImportSaveFailure {
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    if (/Login required/i.test(raw)) return 'signed-out';
    if (/Account changed/i.test(raw)) return 'account-changed';
    if (!online || /Failed to fetch|Load failed|NetworkError|network connection|Database not available/i.test(raw))
        return 'offline';
    if (/timed out|timeout/i.test(raw)) return 'timed-out';
    return 'unknown';
}

/**
 * The failure in words. "Nothing was kept" holds for every path: a failed
 * import removes what it saved, or fences it for sync to remove (OfflineQueue
 * recreateVoyageWithFence), and nothing is saved before sign-in is checked.
 */
export function importSaveFailureMessage(failure: ImportSaveFailure): string {
    switch (failure) {
        case 'signed-out':
            return "You're signed out, so the voyage couldn't be saved. Sign in, then tap Retry.";
        case 'offline':
            return "No internet connection, so the voyage couldn't be saved. Nothing was kept. Connect, then tap Retry.";
        case 'timed-out':
            return 'Saving timed out. The connection may be slow. Nothing was kept. Tap Retry.';
        case 'account-changed':
            return 'The signed-in account changed while saving, so nothing was kept. Tap Retry to save it to the account signed in now.';
        default:
            return "The voyage couldn't be saved to the Ship's Log. Nothing was kept. Tap Retry.";
    }
}

/**
 * A coordinate as degrees and minutes. Rounded once to a tenth of a minute,
 * so 179.99999° reads 180°0.0' rather than 179°60.0' (132-B21).
 */
export function formatCoord(value: number, posChar: string, negChar: string): string {
    const tenths = Math.round(Math.abs(value) * 600);
    const degrees = Math.floor(tenths / 600);
    const minutes = ((tenths % 600) / 10).toFixed(1);
    return `${degrees}°${minutes}'${value >= 0 ? posChar : negChar}`;
}

const SPOKEN_HEMISPHERE: Record<string, string> = { N: 'north', S: 'south', E: 'east', W: 'west' };

/** The same coordinate for VoiceOver, which reads ° and ' as symbols. */
export function spokenCoord(value: number, posChar: string, negChar: string): string {
    const tenths = Math.round(Math.abs(value) * 600);
    const degrees = Math.floor(tenths / 600);
    const minutes = ((tenths % 600) / 10).toFixed(1);
    return `${degrees} degrees ${minutes} minutes ${SPOKEN_HEMISPHERE[value >= 0 ? posChar : negChar]}`;
}
