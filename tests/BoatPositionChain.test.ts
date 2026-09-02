/**
 * Which GPS the app believes, in order.
 *
 * Shane 2026-09-03: "a: garmin gps b: usb gps c: phone gps." The middle rung
 * did not exist before — the USB receiver is plugged into the Pi and the phone
 * had no way to reach it, so the chain was really bus-then-phone, and a boat
 * whose gateway was merely unreachable fell all the way to a receiver in
 * somebody's pocket.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeRung } from '../services/boatPositionChain';

const chain = readFileSync('services/boatPositionChain.ts', 'utf8');
const anchor = readFileSync('services/AnchorWatchService.ts', 'utf8');

describe('the boat position chain', () => {
    it('tries the bus first, then the Pi, and returns null rather than the phone', () => {
        const fn = chain.slice(chain.indexOf('export async function boatFix'));
        const bus = fn.indexOf('busFix()');
        const pi = fn.indexOf('await piFix()');
        expect(bus).toBeGreaterThan(-1);
        expect(pi).toBeGreaterThan(bus);
        // The phone is never chosen HERE: whether a phone fix is acceptable
        // depends on what the position is for, and that is the caller's call.
        expect(fn).toMatch(/return null;/);
        expect(fn).not.toMatch(/Geolocation|BgGeoManager|getCurrentPosition/);
    });

    it('the anchor watch asks the Pi only when the bus is silent, before the phone', () => {
        const fn = anchor.slice(anchor.indexOf('const nmeaPos = NmeaGpsProvider.getPosition()'));
        const ask = fn.indexOf('nmeaPos ? null : await piFix()');
        const useBus = fn.indexOf('if (nmeaPos) {');
        const usePi = fn.indexOf('} else if (piBoatFix) {');
        const usePhone = fn.indexOf('// Fall back to phone GPS');
        expect(ask).toBeGreaterThan(-1);
        expect(useBus).toBeGreaterThan(-1);
        expect(usePi).toBeGreaterThan(useBus);
        expect(usePhone).toBeGreaterThan(usePi);
    });

    it('never throws a rung into the caller', () => {
        // A Pi that is asleep or has no /api/gps must cost nothing.
        expect(chain).not.toMatch(/\bthrow new /);
        expect(chain).toMatch(/} catch \{/);
    });

    it('says which receiver answered, in words a skipper would use', () => {
        expect(describeRung(null)).toBe('Phone GPS');
        expect(describeRung({ latitude: 0, longitude: 0, timestamp: 0, rung: 'bus' })).toBe('Boat GPS');
        expect(describeRung({ latitude: 0, longitude: 0, timestamp: 0, rung: 'pi', source: 'ublox-gps.GP' })).toBe(
            'USB GPS (Pi)',
        );
        expect(describeRung({ latitude: 0, longitude: 0, timestamp: 0, rung: 'pi', source: 'ydwg-tcp.YD' })).toBe(
            'Boat GPS (via Pi)',
        );
    });

    it('the Pi ranks its two receivers rather than taking Signal K last-writer answer', () => {
        // Measured on Calypso 2026-09-03: navigation.position was won by
        // ydwg-tcp.YD while navigation.gnss.methodQuality was simultaneously
        // won by ublox-gps.GP — same instant, different winners.
        const broadcaster = readFileSync('pi-cache/src/anchorBroadcaster.ts', 'utf8');
        expect(broadcaster).toMatch(/export function rankSource/);
        expect(broadcaster).toMatch(/DEFAULT_SOURCE_PRIORITY = \['ydwg', 'n2k', 'nmea', 'ublox', 'usb', 'gps'\]/);
        // And readFix must CHOOSE from the per-source map when one is present.
        const read = broadcaster.slice(broadcaster.indexOf('export function readFix'));
        expect(read).toMatch(/position\.values/);
        expect(read).toMatch(/rankSource\(a\.source\) - rankSource\(b\.source\)/);
    });

    it('the Pi exposes the boat fix so the middle rung is reachable at all', () => {
        const server = readFileSync('pi-cache/src/server.ts', 'utf8');
        expect(server).toMatch(/app\.get\('\/api\/gps', requireAppApi/);
        expect(chain).toMatch(/\$\{baseUrl\}\/api\/gps/);
    });
});
