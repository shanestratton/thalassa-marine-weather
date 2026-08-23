/**
 * The ingest bounding box, pinned to the passages it actually has to cover.
 *
 * This box is easy to narrow "safely" — it looks like a dead aisstream setting
 * and trimming it looks like pure savings. It is not: the AISHub aggregate
 * poller derives its query bounds from BOUNDING_BOXES[0], so this rectangle
 * decides what the shared pond CONTAINS from whichever upstream is alive.
 *
 * It was [-44,140]..[-9,162] until 2026-08-24, which ended about 4.5° short of
 * New Caledonia — a Brisbane–Noumea crossing would have lost AIS fill roughly
 * halfway, in the emptiest water of the trip, which is where you least want to
 * be blind to shipping.
 *
 * So the contract is expressed as PLACES rather than numbers. If someone
 * narrows it again, this fails naming the port they just cut off.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_BOUNDING_BOXES, parseBoundingBoxes, resolveBoundingBoxes } from './boundingBox.js';

const src = readFileSync('boundingBox.ts', 'utf8');
const indexSrc = readFileSync('index.ts', 'utf8');
const DEFAULT = JSON.parse(DEFAULT_BOUNDING_BOXES) as number[][][];

const box = DEFAULT[0];
const covers = (lat: number, lon: number): boolean =>
    lat >= box[0][0] && lat <= box[1][0] && lon >= box[0][1] && lon <= box[1][1];

describe('ingest bounding box', () => {
    it('parses as the shape aisstream and the AISHub poller both expect', () => {
        // [[[latMin,lonMin],[latMax,lonMax]]] — the poller indexes [0][0]/[0][1]
        // and [1][0]/[1][1] directly, so a malformed box silently stops it.
        expect(Array.isArray(DEFAULT)).toBe(true);
        expect(box).toHaveLength(2);
        expect(box[0][0]).toBeLessThan(box[1][0]);
        expect(box[0][1]).toBeLessThan(box[1][1]);
    });

    it.each([
        ['Moreton Bay', -27.4, 153.2],
        ['Townsville', -19.26, 146.82],
        ['Lady Musgrave', -23.9, 152.4],
        ['Torres Strait', -10.5, 142.2],
        ['Hobart', -42.88, 147.33],
        ['Lord Howe Island', -31.55, 159.08],
        ['Norfolk Island', -29.03, 167.95],
        ['Noumea, New Caledonia', -22.27, 166.45],
        ['Port Vila, Vanuatu', -17.73, 168.32],
    ])('covers %s', (_name, lat, lon) => {
        expect(covers(lat, lon)).toBe(true);
    });

    it('still excludes the water we deliberately do not pay for', () => {
        // Width is the cost driver — the 1.8 TB incident was a global box. These
        // are excluded on purpose, not by oversight; if a user ever cruises
        // there, widen it deliberately rather than discovering it at sea.
        expect(covers(-32.05, 115.74)).toBe(false); // Fremantle, WA
        expect(covers(-12.46, 130.84)).toBe(false); // Darwin, NT
        expect(covers(-36.85, 174.76)).toBe(false); // Auckland, NZ
    });

    it('survives a mistyped dashboard override instead of crash-looping', () => {
        // This parse runs at module load. An unguarded JSON.parse on a
        // fat-fingered Railway field would take the container down before it
        // could log why, and a worker that will not boot is far worse than a
        // box of the wrong shape.
        expect(parseBoundingBoxes(undefined)).toEqual(DEFAULT);
        expect(parseBoundingBoxes('')).toEqual(DEFAULT);
        expect(parseBoundingBoxes('   ')).toEqual(DEFAULT);
        expect(parseBoundingBoxes('[[[-44,140],[-9,172]')).toEqual(DEFAULT); // truncated
        expect(parseBoundingBoxes('not json at all')).toEqual(DEFAULT);
        expect(parseBoundingBoxes('[]')).toEqual(DEFAULT);
        expect(parseBoundingBoxes('[[["a","b"],[1,2]]]')).toEqual(DEFAULT); // non-numeric
    });

    it('rejects the one-bracket-short typo that would parse but break the poller', () => {
        // Valid JSON, wrong nesting. The AISHub poller indexes [0][0] and
        // [1][1] directly, so this would sail through a bare JSON.parse and
        // hand it undefined bounds at query time — a silent wrong answer
        // rather than a loud failure.
        expect(parseBoundingBoxes('[[-44,140],[-9,172]]')).toEqual(DEFAULT);
    });

    it('still honours a well-formed override', () => {
        expect(parseBoundingBoxes('[[[-45,110],[-8,157]]]')).toEqual([[[-45, 110], [-8, 157]]]);
    });

    it('reports whether the box came from the dashboard or this repo', () => {
        // Otherwise the only way to know an env override is beating the code
        // default is to read the Railway variables tab and trust it.
        expect(resolveBoundingBoxes(undefined).source).toBe('code default');
        expect(resolveBoundingBoxes('  ').source).toBe('code default');
        expect(resolveBoundingBoxes('[[[-45,110],[-8,157]]]').source).toBe('BOUNDING_BOXES env override');
    });

    it('documents that the box is not aisstream-only', () => {
        // The comment is load-bearing: it is the only thing telling the next
        // person that trimming this also trims the AISHub aggregate.
        expect(src).toContain('NOT AISSTREAM-ONLY');
        expect(src).toContain('AISHub aggregate poller');
        // ...and that the crowd-feed is deliberately unbounded by it.
        expect(src).toContain('Contribution is global; aggregate fill is boxed');
    });

    it('logs which box won at boot', () => {
        expect(indexSrc).toContain('Bounding box in force');
        expect(indexSrc).toContain('resolveBoundingBoxes');
    });
});

/**
 * aisstream is dead service-wide (2026-08-05, their issue #269 and a dozen
 * like it, zero maintainer replies). Its key must therefore be OPTIONAL: the
 * worker used to `process.exit(1)` without it, so tidying a useless credential
 * out of the Railway variables made the container exit on boot, left nothing
 * serving /health, and failed the deploy (Shane, 2026-08-24).
 *
 * Everything else here — the punter crowd-feed, the AISHub poller, the DB
 * flush loop, the health endpoint — is independent of aisstream.
 */
describe('aisstream is optional', () => {
    const idx = readFileSync('index.ts', 'utf8');

    it('never exits the process over a missing AISSTREAM_KEY', () => {
        const guard = idx.slice(idx.indexOf('const AISSTREAM_ENABLED'), idx.indexOf('// ── State ──'));
        expect(guard).not.toContain('process.exit');
        expect(guard).toContain('aisstream feed disabled');
    });

    it('opens the socket and arms its watchdog only when enabled', () => {
        // A dead-man switch for a socket that was never opened would reconnect
        // forever against a service that is gone.
        expect(idx).toContain('if (AISSTREAM_ENABLED) connect();');
        expect(idx).toContain('if (AISSTREAM_ENABLED) setInterval(checkStaleConnection');
    });

    it('reports a deliberately-off feed as healthy, not degraded', () => {
        // lastMessageAt never advances with the socket closed, so the
        // staleness test would cry 'degraded-upstream' forever about a feed
        // that is off on purpose — and a permanent alarm is one nobody reads.
        const health = idx.slice(idx.indexOf('const dbWedged'), idx.indexOf('uptimeSeconds'));
        expect(health).toContain('!AISSTREAM_ENABLED');
        expect(health).toContain("aisstream: AISSTREAM_ENABLED ? 'enabled' : 'disabled'");
    });
});
