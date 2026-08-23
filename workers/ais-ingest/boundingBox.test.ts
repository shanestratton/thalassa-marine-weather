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

const src = readFileSync('index.ts', 'utf8');
const DEFAULT = JSON.parse(
    /const DEFAULT_BOUNDING_BOXES = '(.+?)';/.exec(src)?.[1] ?? 'null',
) as number[][][];

const box = DEFAULT?.[0];
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

    it('documents that the box is not aisstream-only', () => {
        // The comment is load-bearing: it is the only thing telling the next
        // person that trimming this also trims the AISHub aggregate.
        expect(src).toContain('NOT AISSTREAM-ONLY');
        expect(src).toContain('AISHub aggregate poller');
        // ...and that the crowd-feed is deliberately unbounded by it.
        expect(src).toContain('Contribution is global; aggregate fill is boxed');
    });
});
