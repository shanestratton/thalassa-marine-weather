/**
 * The words on the passage strip — checked against the REAL GPS status
 * resolver. Two earlier cuts of the GPS line were each tested against a
 * hand-written `detail` the resolver never produces, and each rendered the
 * same text for a live feed and a three-minute-dead one.
 */
import { describe, expect, it } from 'vitest';
import { resolveGpsReceiverStatus, type GpsReceiverStatusInput } from '../services/GpsReceiverStatusService';
import {
    fixSourceSentence,
    fixSourceTag,
    fmtBearing,
    fmtKnots,
    fmtNm,
    fmtRelative,
    gpsStateTag,
    laneSentence,
    laneTag,
} from '../components/passage/passageHudFormat';

const NOW = 1_750_000_000_000;

function input(overrides: Partial<GpsReceiverStatusInput> = {}): GpsReceiverStatusInput {
    return {
        now: NOW,
        nmea: {
            connection: {
                status: 'disconnected',
                enabled: false,
                host: '192.168.1.151',
                port: 1456,
                deviceId: 'ydwg02',
                deviceLabel: 'Yacht Devices YDWG-02',
                transport: 'tcp',
            },
            feedStatus: 'unavailable',
            fixAgeMs: null,
            satellites: null,
            hdop: null,
            qualityLabel: 'GPS',
        },
        native: {
            source: { hasLocation: false, timestampMs: null, externalAccessory: false, simulated: false },
            accessories: [],
        },
        precision: { active: false, avgAccuracy: null },
        ...overrides,
    };
}

describe('the GPS state tag, from what the resolver really says', () => {
    it('tells a live Pi feed from a dead one — they must never read the same', () => {
        const live = resolveGpsReceiverStatus(
            input({
                nmea: {
                    ...input().nmea,
                    feedStatus: 'live',
                    fixAgeMs: 1_500,
                    satellites: 11,
                    hdop: 0.9,
                    remote: { via: 'lan', ageMs: 1_500 },
                },
            }),
        );
        const dead = resolveGpsReceiverStatus(
            input({
                nmea: {
                    ...input().nmea,
                    feedStatus: 'stale',
                    fixAgeMs: 180_000,
                    remote: { via: 'lan', ageMs: 180_000 },
                },
            }),
        );
        expect(live.detail).toBe('Live via the Pi · GPS · 11 sats · HDOP 0.9');
        expect(gpsStateTag(live.detail)).toBe('GPS LIVE');
        expect(dead.detail).toContain('Last GPS sentence 3m ago via the Pi');
        expect(gpsStateTag(dead.detail)).toBe('GPS 3M OLD');
        expect(gpsStateTag(live.detail)).not.toBe(gpsStateTag(dead.detail));
    });

    it('reads the gateway branches too, wherever the state clause sits', () => {
        const socketLive = resolveGpsReceiverStatus(
            input({
                nmea: {
                    ...input().nmea,
                    connection: { ...input().nmea.connection, status: 'connected', enabled: true },
                    feedStatus: 'live',
                    fixAgeMs: 800,
                    satellites: 9,
                    hdop: 1.1,
                },
            }),
        );
        expect(gpsStateTag(socketLive.detail)).toBe('GPS LIVE');
        const waiting = resolveGpsReceiverStatus(
            input({
                nmea: {
                    ...input().nmea,
                    connection: { ...input().nmea.connection, status: 'connected', enabled: true },
                },
            }),
        );
        expect(waiting.detail).toContain('Waiting for GPS position');
        expect(gpsStateTag(waiting.detail)).toBe('GPS WAITING');
    });

    it('marks the cloud row and the phone for what they are, and stays silent on the unknown', () => {
        expect(gpsStateTag('Through the cloud, 40s ago · this phone steers by its own GPS')).toBe('GPS · CLOUD');
        expect(gpsStateTag('iPhone GPS in use')).toBe('PHONE GPS');
        expect(gpsStateTag('Connected to iPhone · Supplying position')).toBe('EXT GPS LIVE');
        expect(gpsStateTag('No position yet — nothing is supplying a fix')).toBe('NO GPS FIX');
        expect(gpsStateTag('Something new the resolver learned to say')).toBeNull();
    });
});

describe('numbers', () => {
    const live = (value: number | null) => ({ value, freshness: 'live' as const });
    it('formats knots, bearings, relative angles and miles', () => {
        expect(fmtKnots(live(6.14))).toBe('6.1');
        expect(fmtKnots(live(17.6))).toBe('18');
        expect(fmtKnots(live(null))).toBe('—');
        expect(fmtBearing(live(44))).toBe('044°');
        expect(fmtBearing(live(359.6))).toBe('000°');
        expect(fmtBearing(live(null))).toBe('—');
        expect(fmtRelative(live(-33))).toBe('33°P');
        expect(fmtRelative(live(120))).toBe('120°S');
        expect(fmtNm(8.26)).toBe('8.3');
        expect(fmtNm(83.4)).toBe('83');
    });
});

describe('whose position, and which lane', () => {
    it('names the source of the route figure', () => {
        expect(fixSourceTag('boat', 0)).toBe('BOAT GPS');
        expect(fixSourceTag('boat-cloud', 0)).toBe('BOAT · CLOUD');
        expect(fixSourceTag('phone', 0)).toBe('PHONE GPS');
        expect(fixSourceTag('phone-old', 3)).toBe('PHONE 3M');
        expect(fixSourceSentence('boat-cloud', 0)).toContain('does not steer this phone');
        expect(fixSourceSentence('phone-old', 3)).toBe('By this phone’s GPS, last fix 3 min ago');
    });

    it('names the instrument lane', () => {
        expect(laneTag('lan', true, true)).toBe('VIA PI');
        expect(laneTag('cloud', true, true)).toBe('CLOUD');
        expect(laneTag(null, true, true)).toBe('GATEWAY');
        expect(laneTag(null, true, false)).toBe('NO INSTR');
        expect(laneTag(null, false, false)).toBe('NO INSTR');
        expect(laneSentence('cloud', true, true)).toContain('not steering');
    });
});
