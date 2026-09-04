/**
 * The SDK's location queue must be bounded, because nothing ever drains it.
 *
 * Fixes reach this app through onLocation. getLocations() is called NOWHERE.
 * But the SDK also writes every fix to its own SQLite, and
 * maxRecordsToPersist defaults to -1 — no limit — so that database grew for
 * the life of every voyage, unread and unpruned.
 *
 * Measured on Shane's phone 2026-09-04 after an hour-long route: 11,090 rows,
 * 11MB. His app died 1ms after entering the native teardown and never
 * returned, with no error-boundary marker — a dead process, not a caught
 * error. And it compounded: every failed stop left the queue intact, so the
 * next attempt had more to chew through than the last.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mgr = readFileSync('services/BgGeoManager.ts', 'utf8');
const code = mgr.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('background geolocation persistence', () => {
    it('caps the records the SDK keeps', () => {
        expect(code).toMatch(/persistence:\s*\{[\s\S]{0,200}maxRecordsToPersist:\s*1000/);
        expect(code).toMatch(/persistence:\s*\{[\s\S]{0,200}maxDaysToPersist:\s*1/);
    });

    it('never leaves it unbounded', () => {
        // -1 is the SDK default and the bug; 0 would disable persistence
        // entirely, which forfeits any future crash-recovery path.
        expect(code).not.toMatch(/maxRecordsToPersist:\s*-1/);
        expect(code).not.toMatch(/maxRecordsToPersist:\s*0\b/);
    });

    it('drains the queue after a verified stop, and cannot fail the stop', () => {
        // Called through a capability check: housekeeping on an optional SDK
        // surface must never be able to break a stop. A build without the
        // method threw straight through the verified stop — the exact shape of
        // the bug this change exists to fix.
        expect(code).toMatch(/destroyLocations;/);
        expect(code).toMatch(/if \(typeof drain === 'function'\)/);
        expect(code).toMatch(/Promise\.resolve\(drain\.call\(BackgroundGeolocation\)\)\.catch\(/);
        // After the stop is verified — giving storage back must never be the
        // reason a skipper cannot end a voyage.
        const stop = code.indexOf('await BackgroundGeolocation.stop();');
        const drain = code.indexOf('drain.call(BackgroundGeolocation)');
        expect(stop).toBeGreaterThan(-1);
        expect(drain).toBeGreaterThan(stop);
    });

    it('still consumes fixes from the event stream, not the table', () => {
        // If this ever changes, draining the table stops being free.
        expect(code).toMatch(/BackgroundGeolocation\.onLocation\(/);
        expect(code).not.toMatch(/BackgroundGeolocation\.getLocations\(/);
    });
});
