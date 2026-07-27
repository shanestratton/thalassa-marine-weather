/**
 * Multi-vessel tracking is a safety boundary: a voyage must retain the boat
 * selected at cast-off even if the skipper changes their active profile later.
 *
 * These source contracts make that association explicit without pulling the
 * native GPS stack into a unit test. Behavioural ship-log tests can then
 * exercise the concrete implementation at their own layer.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const trackingStateSource = readFileSync('services/shiplog/TrackingStateStore.ts', 'utf8');
const shipLogSource = readFileSync('services/ShipLogService.ts', 'utf8');

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = start === -1 ? -1 : source.indexOf(endMarker, start + startMarker.length);
    return start === -1 || end === -1 ? '' : source.slice(start, end);
}

describe('multi-vessel tracking persistence contract', () => {
    it('declares boatId as a first-class persisted tracking-state field', () => {
        const trackingState = sourceBlock(trackingStateSource, 'export interface TrackingState {', '\n}');

        expect(trackingState).toMatch(/\bboatId\??:\s*string\b/);
        // saveTrackingState snapshots and wraps the complete state before it
        // writes Preferences. This guards against a future hand-picked
        // serialiser quietly dropping the boat association.
        expect(trackingStateSource).toMatch(/const snapshot = \{ \.\.\.state \};/);
        expect(trackingStateSource).toMatch(/JSON\.stringify\(ownedValue\(snapshot, scope\)\)/);
    });

    it('binds the selected boat before startTracking persists a new voyage', () => {
        const startTracking = sourceBlock(shipLogSource, 'async startTracking(', '\n    /**');

        expect(startTracking).not.toBe('');
        expect(startTracking).toMatch(/this\.trackingState\s*=\s*\{[\s\S]*?\bboatId\s*:/);
        expect(startTracking).toMatch(/await this\.saveTrackingState\(scope\)/);
    });
});
