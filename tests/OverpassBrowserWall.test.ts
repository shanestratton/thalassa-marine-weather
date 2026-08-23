/**
 * Overpass refuses browsers, and a browser cannot argue back.
 *
 * MEASURED 2026-08-23 against overpass-api.de, paced clear of its 2-slot rate
 * limiter, each shape repeated. Method, body and Origin held identical; only
 * the User-Agent varied:
 *
 *   curl/8.x          200   CORS header present
 *   Thalassa/1.2.0    504   CORS header present  (allowed — that query is heavy)
 *   Chrome 140        406   NO CORS header
 *   iOS WKWebView     406   NO CORS header
 *   (none)            406   NO CORS header
 *
 * That is OSM policy working as designed: their services want a User-Agent
 * identifying the application, and reject browser-like and empty ones.
 *
 * `fetch()` cannot comply — User-Agent is a forbidden header. And because the
 * 406 carries no CORS headers, Chrome reports it as "No
 * 'Access-Control-Allow-Origin'", which reads like a policy problem in this
 * app and is not one.
 *
 * Adding the hosts to connect-src earlier the same day was necessary but not
 * sufficient: it removed the first wall and revealed the second.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('services/weather/shelter/coastlineSource.ts', 'utf8');

describe('coastline on web', () => {
    it('does not fire a request that cannot succeed', () => {
        // Two doomed cross-origin POSTs per weather fetch bought nothing but
        // latency and a console full of errors that looked like our bug.
        expect(src).toContain('const CAN_REACH_OVERPASS = Capacitor.isNativePlatform();');
        const fn = src.slice(src.indexOf('async function queryOverpass'), src.indexOf('const dLat ='));
        expect(fn).toContain('if (!CAN_REACH_OVERPASS)');
        expect(fn).toContain('return null;');
    });

    it('still tries on native, which is not disproven', () => {
        // The phone's User-Agent is not the browser's. Skipping there would
        // be hiding a working path, not fixing a broken one.
        expect(src).not.toContain('const CAN_REACH_OVERPASS = false');
        expect(src).toContain('Capacitor.isNativePlatform()');
    });

    it('says why, once, rather than per call', () => {
        // A per-call warning is the same console spam in a different coat.
        expect(src).toContain('let warnedNoOverpass = false;');
        expect(src).toContain('warnedNoOverpass = true;');
        expect(src).toContain('406');
    });

    it('records the measurement, not the conclusion', () => {
        // The next person needs to know it was tested and how, or this gets
        // "fixed" again by re-adding the fetch.
        expect(src).toContain('User-Agent is a forbidden header');
        // Substring chosen to sit inside one comment line — the sentence
        // wraps, and a wrapped assertion fails on reflow rather than on
        // meaning.
        expect(src).toContain('CORS message is the symptom');
    });

    it('keeps the hosts in CSP — native uses them', () => {
        // Removing them would break the platform where this still works.
        for (const f of ['index.html', 'vercel.json']) {
            expect(readFileSync(f, 'utf8')).toContain('https://overpass-api.de');
        }
    });

    it('fails safe: no coastline means treat the spot as exposed', () => {
        // The shelter engine caps wave damping by fetched coastline, so an
        // absent answer over-reports wave height rather than under-reporting
        // it. That is the correct direction to be wrong at sea.
        const shelter = readFileSync('services/weather/shelter/index.ts', 'utf8');
        expect(shelter).toContain('coastline data is unavailable');
    });
});
