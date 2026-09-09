import { describe, expect, it } from 'vitest';
import type { NmeaStoreState, TimestampedMetric } from '../services/NmeaStore';
import type { NmeaConnectionStatus } from '../services/NmeaListenerService';
import { deriveNmeaBackboneStatus, type NmeaBackboneStatusInput } from '../utils/nmeaBackboneStatus';

const NOW = Date.parse('2026-09-10T02:00:00Z');
const metric = (value: number | null = null, ageMs = 0): TimestampedMetric => ({
    value,
    lastUpdated: value === null ? 0 : NOW - ageMs,
    freshness: value === null ? 'dead' : 'live',
});

function emptyStore(overrides: Partial<NmeaStoreState> = {}): NmeaStoreState {
    return {
        tws: metric(),
        twa: metric(),
        twaSigned: metric(),
        heel: metric(),
        pitch: metric(),
        twd: metric(),
        aws: metric(),
        awa: metric(),
        stw: metric(),
        heading: metric(),
        depth: metric(),
        depthSource: null,
        depthReference: null,
        depthOffsetM: null,
        sog: metric(),
        cog: metric(),
        waterTemp: metric(),
        rudder: metric(),
        rpm: metric(),
        voltage: metric(),
        latitude: metric(),
        longitude: metric(),
        hdop: metric(),
        satellites: metric(),
        gpsFixQuality: null,
        connectionStatus: 'disconnected',
        remote: null,
        lastAnyUpdate: 0,
        ...overrides,
    };
}

function piStore(via: 'lan' | 'cloud' = 'lan'): NmeaStoreState {
    return emptyStore({
        connectionStatus: 'remote',
        remote: { source: 'pi', via, deviceLabel: 'calypso', reportedAt: NOW - 2_000, receivedAt: NOW },
        depth: metric(12.4),
        lastAnyUpdate: NOW,
    });
}

function derive(overrides: Partial<NmeaBackboneStatusInput> = {}) {
    return deriveNmeaBackboneStatus({
        store: emptyStore(),
        directStatus: 'disconnected',
        deviceLabel: 'YDWG-02',
        lastError: null,
        viaRemoteAccess: false,
        now: NOW,
        ...overrides,
    });
}

describe('the NMEA backbone through the Pi', () => {
    it.each<NmeaConnectionStatus>(['disconnected', 'connecting', 'error'])(
        'shows a fresh LAN feed despite the unused direct socket being %s',
        (directStatus) => {
            expect(derive({ store: piStore(), directStatus, lastError: 'Old socket failure.' })).toEqual({
                active: true,
                detail: 'Connected via the Pi',
                faulted: false,
                showRates: false,
            });
        },
    );

    it('identifies the Pi over tailnet without claiming a phone gateway connection', () => {
        expect(derive({ store: piStore(), viaRemoteAccess: true })).toEqual({
            active: true,
            detail: 'Connected via the Pi · tailnet',
            faulted: false,
            showRates: false,
        });
    });

    it('names the Pi cloud lane without claiming a realtime connection or direct sentence rates', () => {
        expect(derive({ store: piStore('cloud'), viaRemoteAccess: true })).toEqual({
            active: true,
            detail: 'Receiving instruments via the Pi · cloud',
            faulted: false,
            showRates: false,
        });
    });

    it('counts an actual zero reading as data', () => {
        const store = piStore();
        store.depth = metric();
        store.sog = metric(0);
        expect(derive({ store }).active).toBe(true);
    });

    it('keeps a valid reading through the store’s usable stale tier', () => {
        const store = piStore();
        store.depth = { ...metric(12.4, 10_000), freshness: 'stale' };
        expect(derive({ store }).active).toBe(true);
    });

    it.each(['lan', 'cloud'] as const)('ages a %s feed without requiring a new sample or store notification', (via) => {
        const store = piStore(via);
        expect(derive({ store }).active).toBe(true);
        const afterSilence = derive({ store, now: NOW + 13_001 });
        expect(afterSilence).toMatchObject({ active: false, faulted: false, showRates: false });
        expect(afterSilence.detail).toContain('no current instrument readings');
    });

    it.each([
        ['lan', 20_000],
        ['cloud', 60_000],
    ] as const)(
        'bounds the %s source and receipt clocks at %i ms independently of a freshly stamped metric',
        (via, maxAge) => {
            const store = piStore(via);
            store.remote!.reportedAt = NOW - maxAge;
            store.remote!.receivedAt = NOW - maxAge;
            expect(derive({ store }).active).toBe(true);

            store.remote!.reportedAt -= 1;
            expect(derive({ store })).toMatchObject({ active: false, faulted: false, showRates: false });
            store.remote!.reportedAt = NOW;
            expect(derive({ store }).active).toBe(true);

            store.remote!.receivedAt -= 1;
            expect(derive({ store })).toMatchObject({ active: false, faulted: false, showRates: false });
        },
    );

    it.each(['reportedAt', 'receivedAt'] as const)('rejects invalid or excessively future %s values', (field) => {
        for (const timestamp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, NOW + 1_001]) {
            const store = piStore();
            store.remote![field] = timestamp;
            expect(derive({ store })).toMatchObject({ active: false, faulted: false, showRates: false });
        }
    });

    it('allows the store’s one-second source clock skew tolerance', () => {
        const store = piStore();
        store.remote!.reportedAt = NOW + 1_000;
        expect(derive({ store }).active).toBe(true);
    });

    it('does not infer instruments from fresh remote metadata or lastAnyUpdate alone', () => {
        const store = piStore();
        store.depth = metric();
        expect(derive({ store, directStatus: 'error', lastError: 'Unused direct socket failed.' })).toEqual({
            active: false,
            detail: 'The Pi is reporting · no current instrument readings',
            faulted: false,
            showRates: false,
        });
    });

    it('does not keep dead, nonfinite, undated or future-dated metrics active', () => {
        for (const depth of [
            metric(Number.NaN),
            metric(Number.POSITIVE_INFINITY),
            { ...metric(12), freshness: 'dead' as const },
            { ...metric(12), lastUpdated: 0 },
            { ...metric(12), lastUpdated: NOW + 1_001 },
        ]) {
            expect(derive({ store: { ...piStore(), depth } }).active).toBe(false);
        }
    });

    it('does not turn a fresh phone cloud position into an active backbone', () => {
        const store = piStore('cloud');
        store.remote!.source = 'device';
        store.latitude = metric(-27.2);
        store.longitude = metric(153.11);
        expect(derive({ store, directStatus: 'error', lastError: 'Old gateway error.' })).toEqual({
            active: false,
            detail: 'Receiving a phone snapshot · no NMEA instrument feed',
            faulted: false,
            showRates: false,
        });
    });

    it('does not treat remote metadata left in a stopped store as a running feed', () => {
        const store = piStore();
        store.connectionStatus = 'disconnected';
        expect(derive({ store })).toEqual({
            active: false,
            detail: 'Not connected',
            faulted: false,
            showRates: false,
        });
    });
});

describe('the phone’s direct NMEA gateway socket', () => {
    it('retains the active connection and rates while waiting for instrument values', () => {
        expect(derive({ directStatus: 'connected' })).toEqual({
            active: true,
            detail: 'Connected via YDWG-02 · waiting for instrument data',
            faulted: false,
            showRates: true,
        });
    });

    it('names live direct data and ignores a previous connection error', () => {
        expect(
            derive({
                store: emptyStore({ connectionStatus: 'connected', sog: metric(0) }),
                directStatus: 'connected',
                lastError: 'Old failure.',
            }),
        ).toEqual({
            active: true,
            detail: 'Connected via YDWG-02 · live vessel data',
            faulted: false,
            showRates: true,
        });
    });

    it('gives a connected direct socket precedence during the handover from a remote feed', () => {
        const status = derive({ store: piStore('cloud'), directStatus: 'connected' });
        expect(status).toMatchObject({ active: true, faulted: false, showRates: true });
        expect(status.detail).toContain('YDWG-02');
    });

    it('shows connecting without repeating an old diagnosed fault', () => {
        expect(derive({ directStatus: 'connecting', lastError: 'Previous connection failed.' })).toEqual({
            active: false,
            detail: 'Connecting to YDWG-02',
            faulted: false,
            showRates: false,
        });
    });

    it.each<NmeaConnectionStatus>(['error', 'disconnected'])(
        'keeps an actionable fault when the direct socket is %s and no remote feed exists',
        (directStatus) => {
            expect(
                derive({
                    directStatus,
                    lastError: 'The gateway stopped sending. Check its power. (SocketError native code 54)',
                }),
            ).toEqual({
                active: false,
                detail: 'The gateway stopped sending.',
                faulted: true,
                showRates: false,
            });
        },
    );

    it('bounds and cleans a native error without a sentence terminator', () => {
        const status = derive({
            directStatus: 'error',
            lastError: `  ${'Gateway unavailable '.repeat(10)}\n (SocketError native code 54)  `,
        });
        expect(status.detail.length).toBeLessThanOrEqual(96);
        expect(status.detail).not.toContain('SocketError');
        expect(status.detail).not.toContain('\n');
        expect(status.detail.endsWith('…')).toBe(true);
    });

    it('marks a direct error as faulted even if the transport supplied no message', () => {
        expect(derive({ directStatus: 'error' })).toEqual({
            active: false,
            detail: 'Gateway connection failed',
            faulted: true,
            showRates: false,
        });
    });

    it('keeps an ordinary disconnected socket neutral', () => {
        expect(derive()).toEqual({
            active: false,
            detail: 'Not connected',
            faulted: false,
            showRates: false,
        });
    });
});
