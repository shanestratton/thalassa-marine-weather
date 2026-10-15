/**
 * 132-B21: the words the GPX import preview uses — notes on what the import
 * decided, why a save failed, and coordinates near the 180° line.
 */
import { describe, expect, it } from 'vitest';
import {
    classifyImportSaveFailure,
    formatCoord,
    formatImportDuration,
    gpxImportNotes,
    importSaveFailureMessage,
    spokenCoord,
} from '../components/vessel/gpxImportPreview';
import type { GpxTrackImport } from '../services/gpxService';

const parsed = (over: Partial<GpxTrackImport>): GpxTrackImport => ({
    entries: [],
    trackPoints: 100,
    savedTrackPoints: 100,
    segments: 1,
    untimedTrackPoints: 0,
    untimedWaypoints: 0,
    skippedPoints: 0,
    firstTimeMs: 0,
    lastTimeMs: 3_600_000,
    totalDistanceNM: 6,
    bounds: null,
    fallbackDate: null,
    ...over,
});

describe('gpxImportNotes (132-B21)', () => {
    it('says nothing about a clean, timed, single-segment track', () => {
        expect(gpxImportNotes(parsed({}))).toEqual([]);
    });

    it('says a long track is thinned, by how much, and that distance and times use every point', () => {
        const [note] = gpxImportNotes(parsed({ trackPoints: 50_000, savedTrackPoints: 5_001 }));
        expect(note).toBe(
            'Long track: 50,000 points. The log keeps about 1 in every 10 (5,001 points), so it saves quickly. ' +
                'Distance and times come from all 50,000.',
        );
    });

    it("names the file's own date when it had no times", () => {
        const timeMs = Date.UTC(2026, 2, 14, 2);
        const [note] = gpxImportNotes(
            parsed({
                untimedTrackPoints: 100,
                firstTimeMs: null,
                lastTimeMs: null,
                fallbackDate: { source: 'file', timeMs },
            }),
        );
        const date = new Date(timeMs).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        });
        expect(note).toBe(
            `The track has no times, so speed and duration are unknown. It will be logged on ${date}, the date saved in the file.`,
        );
    });

    it("says plainly when an undated file will be logged under today's date", () => {
        const [note] = gpxImportNotes(
            parsed({ trackPoints: 0, savedTrackPoints: 0, fallbackDate: { source: 'import', timeMs: Date.now() } }),
        );
        expect(note).toBe(
            "The waypoints have no times, so speed and duration are unknown. It will be logged under today's date.",
        );
    });

    it('counts untimed points, untimed waypoints, segments and skipped points, singular and plural', () => {
        expect(
            gpxImportNotes(parsed({ untimedTrackPoints: 1, untimedWaypoints: 3, segments: 4, skippedPoints: 1 })),
        ).toEqual([
            '1 track point has no time. It is placed between the timed points either side, and gets no speed.',
            '3 waypoints have no time. Each is logged at the moment the track passed closest to it.',
            "4 track segments. The gaps between them don't count as distance sailed.",
            '1 point has no usable position and will be left out.',
        ]);
    });
});

describe('save failures (132-B21)', () => {
    const kind = (message: string, online = true) => classifyImportSaveFailure(new Error(message), online);

    it('reads each failure the import can raise', () => {
        expect(kind('Login required to import tracks')).toBe('signed-out');
        expect(kind('Account changed during import')).toBe('account-changed');
        expect(kind('Database not available — connect to import tracks')).toBe('offline');
        expect(kind('Import failed at entry 0: TypeError: Failed to fetch')).toBe('offline');
        expect(kind('Import failed at entry 0: TypeError: Load failed')).toBe('offline');
        expect(kind('Import timed out at entry 300')).toBe('timed-out');
        expect(kind('Import failed at entry 0: duplicate key')).toBe('unknown');
        // Whatever the message, an offline phone is the reason to give.
        expect(kind('Import timed out at entry 300', false)).toBe('offline');
        expect(classifyImportSaveFailure(undefined, true)).toBe('unknown');
    });

    it('gives every failure a reason and the Retry it offers', () => {
        for (const failure of ['signed-out', 'offline', 'timed-out', 'account-changed', 'unknown'] as const) {
            expect(importSaveFailureMessage(failure)).toMatch(/Retry/);
        }
        expect(importSaveFailureMessage('signed-out')).toMatch(/signed out/);
        expect(importSaveFailureMessage('offline')).toMatch(/No internet connection/);
        expect(importSaveFailureMessage('timed-out')).toMatch(/timed out/);
    });
});

describe('coordinates and duration (132-B21)', () => {
    it('rounds once, so a point a hair short of 180° never reads 60 minutes', () => {
        expect(formatCoord(179.99999, 'E', 'W')).toBe("180°0.0'E");
        expect(formatCoord(-179.89, 'E', 'W')).toBe("179°53.4'W");
        expect(formatCoord(-27.475, 'N', 'S')).toBe("27°28.5'S");
        expect(spokenCoord(179.9, 'E', 'W')).toBe('179 degrees 54.0 minutes east');
        expect(spokenCoord(-27.475, 'N', 'S')).toBe('27 degrees 28.5 minutes south');
    });

    it("reads the duration from the file's own times, and Unknown without them", () => {
        expect(formatImportDuration(0, 49_999_000)).toBe('13h 53m');
        expect(formatImportDuration(0, 25 * 60_000)).toBe('25m');
        expect(formatImportDuration(null, null)).toBe('Unknown');
        expect(formatImportDuration(0, 0)).toBe('Unknown');
    });
});
