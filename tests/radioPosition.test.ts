import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
    nmea: vi.fn(),
    subscribe: vi.fn(),
    connectionInfo: vi.fn(),
    pairing: vi.fn(),
    piRequest: vi.fn(),
    baseUrl: vi.fn(),
    userId: vi.fn(),
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    abortSignal: vi.fn(),
}));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: io.nmea, subscribe: io.subscribe } }));
vi.mock('../services/NmeaListenerService', () => ({ NmeaListenerService: { getConnectionInfo: io.connectionInfo } }));
vi.mock('../services/PiPairingService', () => ({ getPairing: io.pairing, pinnedPiRequest: io.piRequest }));
vi.mock('../services/PiCacheService', () => ({ piCache: { getBaseUrl: io.baseUrl } }));
vi.mock('../services/supabase', () => ({ supabase: { from: io.from }, getCurrentUserId: io.userId }));

import {
    createRadioBusReader,
    radioPhonePosition,
    radioPositionIsFresh,
    radioTelemetryPosition,
    readRadioBusPosition,
    readRadioCloudPosition,
    readRadioPiPosition,
} from '../services/radioPosition';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const T0 = Date.parse('2026-09-11T01:00:00Z');
const pairing = { deviceId: 'paired-pi', publicKeySpki: 'public-test-key', fingerprint: 'test-public-fingerprint' };
const telemetry = (extra: Record<string, unknown> = {}) => ({
    owner_id: 'radio-account-a',
    boat_id: 'boat-a',
    source: 'pi',
    reported_at: new Date(T0).toISOString(),
    lat: -27.2,
    lon: 153.1,
    sog_kts: 12,
    cog_deg: 90,
    extra: { position_at: T0 - 1_000, wind_history_identity: 'pi-a' },
    ...extra,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => {
        resolve = finish;
    });
    return { resolve, promise };
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    setAuthIdentityScope('radio-account-a');
    io.pairing.mockReturnValue(pairing);
    io.subscribe.mockReturnValue(vi.fn());
    io.connectionInfo.mockReturnValue({ deviceId: 'garmin', host: 'gateway.test', port: 1456 });
    io.baseUrl.mockReturnValue('https://paired-pi.test');
    io.userId.mockResolvedValue('radio-account-a');
    io.piRequest.mockResolvedValue({
        status: 200,
        data: JSON.stringify({ available: true, telemetry: telemetry() }),
    });
    const query = { select: io.select, eq: io.eq, order: io.order, limit: io.limit, abortSignal: io.abortSignal };
    for (const method of [io.from, io.select, io.eq, io.order, io.limit]) method.mockReturnValue(query);
    io.abortSignal.mockResolvedValue({ data: [telemetry()], error: null });
    io.nmea.mockReturnValue({
        connectionStatus: 'connected',
        remote: null,
        latitude: { value: -27.2, lastUpdated: T0 - 1_000 },
        longitude: { value: 153.1, lastUpdated: T0 - 2_000 },
        sog: { value: null, lastUpdated: 0 },
        cog: { value: null, lastUpdated: 0 },
    });
});
afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('radio position observation and provenance', () => {
    it.each(['latitude', 'longitude'] as const)(
        'rejects a future direct %s timestamp even when the other coordinate is older',
        (coordinate) => {
            const state = io.nmea();
            io.nmea.mockReturnValue({
                ...state,
                [coordinate]: { ...state[coordinate], lastUpdated: T0 + 1 },
            });
            expect(readRadioBusPosition()).toBeNull();
        },
    );

    it('uses the coordinate observation time, never a new telemetry/report clock', () => {
        const position = radioTelemetryPosition(telemetry({ extra: { position_at: T0 - 61_000 } }), 'cloud');
        expect(position).toMatchObject({ timestamp: T0 - 61_000, source: 'cloud', isVessel: true });
        expect(radioPositionIsFresh(position!, T0)).toBe(false);
    });

    it.each([undefined, null, '2026-09-11T01:00:00Z', Number.NaN, Number.POSITIVE_INFINITY, 0, T0 + 1])(
        'refuses an unproven/future position timestamp: %s',
        (position_at) => {
            expect(radioTelemetryPosition(telemetry({ extra: { position_at } }), 'pi')).toBeNull();
            expect(radioTelemetryPosition(telemetry({ extra: { position_at } }), 'cloud')).toBeNull();
        },
    );

    it.each(['device', 'phone', undefined, 'unknown'])('refuses telemetry publisher %s as vessel GPS', (source) => {
        expect(radioTelemetryPosition(telemetry({ source }), 'cloud')).toBeNull();
        expect(radioTelemetryPosition(telemetry({ source }), 'pi')).toBeNull();
    });

    it.each([
        { lat: null },
        { lat: Number.NaN },
        { lat: 91 },
        { lon: -181 },
        { lon: '153.1' },
        { extra: null },
        { extra: [] },
    ])('rejects malformed telemetry: %o', (invalid) => {
        expect(radioTelemetryPosition(telemetry(invalid), 'cloud')).toBeNull();
    });

    it('never promotes un-timestamped cloud/Pi motion readings into radio course or speed', () => {
        expect(radioTelemetryPosition(telemetry(), 'pi')).toMatchObject({
            sourceLabel: 'Boat GPS (via Pi)',
            speed: null,
            heading: null,
            accuracy: null,
        });
    });

    it('uses the older coordinate stamp from the direct bus without inventing missing motion', () => {
        expect(readRadioBusPosition()).toMatchObject({
            timestamp: T0 - 2_000,
            source: 'bus',
            speed: null,
            heading: null,
        });
    });

    it('does not treat LAN/cloud aggregate report timestamps as direct bus observation times', () => {
        const direct = io.nmea();
        for (const via of ['lan', 'cloud']) {
            io.nmea.mockReturnValue({ ...direct, connectionStatus: 'remote', remote: { via, source: 'pi' } });
            expect(readRadioBusPosition()).toBeNull();
        }
    });

    it('waits for a proven direct observation instead of relabelling pre-existing cached coordinates', () => {
        const reader = createRadioBusReader();
        expect(reader.read()).toBeNull();
        vi.setSystemTime(T0 + 1_000);
        io.nmea.mockReturnValue({
            ...io.nmea(),
            latitude: { value: -27.2, lastUpdated: T0 + 1_000 },
            longitude: { value: 153.1, lastUpdated: T0 + 1_000 },
        });
        expect(reader.read()).toMatchObject({ timestamp: T0 + 1_000, source: 'bus' });
        reader.dispose();
        expect(io.subscribe.mock.results[0].value).toHaveBeenCalledOnce();
    });

    it('cannot turn retained phone-uploaded remote coordinates into vessel GPS at socket reconnect', () => {
        const reader = createRadioBusReader();
        const observe = io.subscribe.mock.calls[0][0];
        vi.setSystemTime(T0 + 1_000);
        const remote = {
            ...io.nmea(),
            connectionStatus: 'remote',
            remote: { via: 'cloud', source: 'device' },
            latitude: { value: -10, lastUpdated: T0 + 1_000 },
            longitude: { value: 100, lastUpdated: T0 + 1_000 },
            sog: { value: 15, lastUpdated: T0 + 1_000 },
            cog: { value: 270, lastUpdated: T0 + 1_000 },
        };
        io.nmea.mockReturnValue(remote);
        observe(remote);
        vi.setSystemTime(T0 + 2_000);
        const reconnected = { ...remote, connectionStatus: 'connected', remote: null };
        io.nmea.mockReturnValue(reconnected);
        observe(reconnected);
        expect(reader.read()).toBeNull();

        vi.setSystemTime(T0 + 3_000);
        io.nmea.mockReturnValue({
            ...reconnected,
            latitude: { value: -27.2, lastUpdated: T0 + 3_000 },
            longitude: { value: 153.1, lastUpdated: T0 + 3_000 },
        });
        expect(reader.read()).toMatchObject({
            latitude: -27.2,
            longitude: 153.1,
            source: 'bus',
            speed: null,
            heading: null,
        });
        reader.dispose();
    });

    it('only carries independently fresh direct-bus movement readings and converts knots to metres/second', () => {
        const direct = io.nmea();
        io.nmea.mockReturnValue({
            ...direct,
            sog: { value: 1.9438444924406, lastUpdated: T0 - 1_000 },
            cog: { value: 90, lastUpdated: T0 - 11_000 },
        });
        expect(readRadioBusPosition()).toMatchObject({ speed: 1, heading: null });
    });

    it('changes the receiver confirmation key after the configured gateway changes', () => {
        const reader = createRadioBusReader();
        const sampleAt = (timestamp: number) => {
            vi.setSystemTime(timestamp);
            io.nmea.mockReturnValue({
                ...io.nmea(),
                latitude: { value: -27.2, lastUpdated: timestamp },
                longitude: { value: 153.1, lastUpdated: timestamp },
            });
        };
        sampleAt(T0 + 1_000);
        const firstKey = reader.read()?.receiverKey;
        expect(firstKey).toContain('gateway.test');
        vi.setSystemTime(T0 + 2_000);
        io.connectionInfo.mockReturnValue({ deviceId: 'replacement', host: 'other-gateway.test', port: 1456 });
        expect(reader.read()).toBeNull();
        sampleAt(T0 + 3_000);
        expect(reader.read()?.receiverKey).not.toBe(firstKey);
        reader.dispose();
    });

    it('labels phone coordinates as the device and validates invalid measurements', () => {
        expect(
            radioPhonePosition({
                latitude: -27.2,
                longitude: 153.1,
                timestamp: T0,
                accuracy: 8,
                speed: -1,
                heading: -1,
                altitude: null,
            }),
        ).toMatchObject({ source: 'phone', sourceLabel: 'Phone GPS', isVessel: false, speed: null, heading: null });
    });

    it('omits phone zero speed because the GPS service also uses zero for unknown speed', () => {
        expect(
            radioPhonePosition({
                latitude: -27.2,
                longitude: 153.1,
                timestamp: T0,
                accuracy: 8,
                speed: 0,
                heading: null,
                altitude: null,
            }),
        ).toMatchObject({ speed: null, heading: null });
    });
});

describe('read-only paired/authenticated radio adapters', () => {
    it('reads a paired Pi through the existing pinned transport and preserves position_at', async () => {
        const result = await readRadioPiPosition(new AbortController().signal);
        expect(result).toMatchObject({
            source: 'pi',
            timestamp: T0 - 1_000,
            vesselId: null,
            receiverKey: 'pi:paired-pi:test-public-fingerprint',
        });
        expect(io.piRequest).toHaveBeenCalledWith({
            url: 'https://paired-pi.test/api/telemetry',
            connectTimeout: 2_000,
            readTimeout: 2_000,
            responseType: 'text',
        });
    });

    it('makes no Pi request without a saved pairing', async () => {
        io.pairing.mockReturnValue(null);
        await expect(readRadioPiPosition(new AbortController().signal)).resolves.toBeNull();
        expect(io.piRequest).not.toHaveBeenCalled();
    });

    it('rejects a Pi result when pairing changes during the read', async () => {
        const pending = deferred<{ status: number; data: string }>();
        io.piRequest.mockReturnValue(pending.promise);
        const read = readRadioPiPosition(new AbortController().signal);
        await vi.waitFor(() => expect(io.piRequest).toHaveBeenCalledOnce());
        io.pairing.mockReturnValue({ deviceId: 'different-pi', publicKeySpki: 'another-test-key' });
        pending.resolve({ status: 200, data: JSON.stringify({ available: true, telemetry: telemetry() }) });
        await expect(read).resolves.toBeNull();
    });

    it('rejects aborted Pi reads even when the native transport resolves later', async () => {
        const controller = new AbortController();
        const pending = deferred<{ status: number; data: string }>();
        io.piRequest.mockReturnValue(pending.promise);
        const read = readRadioPiPosition(controller.signal);
        await vi.waitFor(() => expect(io.piRequest).toHaveBeenCalledOnce());
        controller.abort();
        pending.resolve({ status: 200, data: JSON.stringify({ available: true, telemetry: telemetry() }) });
        await expect(read).resolves.toBeNull();
    });

    it('reads only needed cloud fields, excludes device uploads, and binds cancellation', async () => {
        const controller = new AbortController();
        await expect(readRadioCloudPosition(controller.signal, 'boat-a')).resolves.toMatchObject({
            source: 'cloud',
            vesselId: 'boat-a',
            receiverKey: 'cloud:boat-a:pi-a',
            timestamp: T0 - 1_000,
        });
        expect(io.from).toHaveBeenCalledWith('vessel_telemetry');
        expect(io.select).toHaveBeenCalledWith('boat_id,source,lat,lon,extra,reported_at');
        expect(io.eq).toHaveBeenCalledWith('source', 'pi');
        expect(io.eq).toHaveBeenCalledWith('boat_id', 'boat-a');
        expect(io.abortSignal).toHaveBeenCalledWith(controller.signal);
    });

    it('keeps cloud confirmation tied to the physical receiver, not only the selected boat', async () => {
        const first = await readRadioCloudPosition(new AbortController().signal, 'boat-a');
        io.abortSignal.mockResolvedValue({
            data: [telemetry({ extra: { position_at: T0, wind_history_identity: 'pi-a' } })],
            error: null,
        });
        const nextObservation = await readRadioCloudPosition(new AbortController().signal, 'boat-a');
        expect(nextObservation?.receiverKey).toBe(first?.receiverKey);
        io.abortSignal.mockResolvedValue({
            data: [telemetry({ extra: { position_at: T0, wind_history_identity: 'replacement-pi' } })],
            error: null,
        });
        const replacement = await readRadioCloudPosition(new AbortController().signal, 'boat-a');
        expect(replacement?.receiverKey).not.toBe(first?.receiverKey);
    });

    it('does not carry cloud confirmation across observations without a published receiver identity', async () => {
        io.abortSignal.mockResolvedValue({
            data: [telemetry({ extra: { position_at: T0 - 1_000 } })],
            error: null,
        });
        const first = await readRadioCloudPosition(new AbortController().signal, 'boat-a');
        io.abortSignal.mockResolvedValue({ data: [telemetry({ extra: { position_at: T0 } })], error: null });
        const nextObservation = await readRadioCloudPosition(new AbortController().signal, 'boat-a');
        expect(first?.receiverKey).toBe(`cloud:boat-a:unidentified:${T0 - 1_000}`);
        expect(nextObservation?.receiverKey).not.toBe(first?.receiverKey);
    });

    it('rejects a device-uploaded cloud result even if returned despite the query filter', async () => {
        io.abortSignal.mockResolvedValue({ data: [telemetry({ source: 'device' })], error: null });
        await expect(readRadioCloudPosition(new AbortController().signal, 'boat-a')).resolves.toBeNull();
    });

    it('does not query cloud without an authenticated identity', async () => {
        io.userId.mockResolvedValue(null);
        await expect(readRadioCloudPosition(new AbortController().signal, 'boat-a')).resolves.toBeNull();
        expect(io.from).not.toHaveBeenCalled();
    });

    it('does not guess which owned or crew vessel to query without an active vessel', async () => {
        await expect(readRadioCloudPosition(new AbortController().signal, null)).resolves.toBeNull();
        expect(io.from).not.toHaveBeenCalled();
    });

    it('refuses another vessel returned despite the exact cloud vessel filter', async () => {
        io.abortSignal.mockResolvedValue({ data: [telemetry({ boat_id: 'boat-b' })], error: null });
        await expect(readRadioCloudPosition(new AbortController().signal, 'boat-a')).resolves.toBeNull();
    });

    it('rejects cloud coordinates returned after the account changes', async () => {
        const pending = deferred<{ data: ReturnType<typeof telemetry>[]; error: null }>();
        io.abortSignal.mockReturnValue(pending.promise);
        const read = readRadioCloudPosition(new AbortController().signal, 'boat-a');
        await vi.waitFor(() => expect(io.abortSignal).toHaveBeenCalledOnce());
        setAuthIdentityScope('radio-account-b');
        pending.resolve({ data: [telemetry()], error: null });
        await expect(read).resolves.toBeNull();
    });

    it('rejects Pi coordinates returned after the account changes', async () => {
        const pending = deferred<{ status: number; data: string }>();
        io.piRequest.mockReturnValue(pending.promise);
        const read = readRadioPiPosition(new AbortController().signal);
        await vi.waitFor(() => expect(io.piRequest).toHaveBeenCalledOnce());
        setAuthIdentityScope('radio-account-b');
        pending.resolve({ status: 200, data: JSON.stringify({ available: true, telemetry: telemetry() }) });
        await expect(read).resolves.toBeNull();
    });
});
