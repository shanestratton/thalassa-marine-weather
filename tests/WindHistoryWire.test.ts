import { afterEach, describe, expect, it, vi } from 'vitest';
import { RollingWindHistory } from '../pi-cache/src/windHistory';
import { readTelemetrySnapshot } from '../pi-cache/src/trackSignalk';
import { buildTelemetryBody } from '../pi-cache/src/telemetryPublisher';
import { parseTelemetryBody } from '../supabase/functions/telemetry-relay/parse';
import { snapshotFromWire } from '../services/telemetryWire';

const now = Date.parse('2026-09-10T03:00:00Z');
afterEach(() => vi.useRealTimers());

describe('wind history across the existing Pi → relay → app wire', () => {
    it('preserves the preceding hour, short peak and original sensor clock through both LAN and cloud', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const record = new RollingWindHistory();
        record.ingest({ source: 'nmea.wind', kts: 31, at: now - 3_000_000 }, now - 3_000_000);
        record.ingest({ source: 'nmea.wind', kts: 19, at: now - 300_000 }, now - 300_000);
        record.ingest({ source: 'nmea.wind', kts: 8, at: now - 2_000 }, now);
        const bus = readTelemetrySnapshot(
            {
                environment: {
                    wind: {
                        speedTrue: {
                            value: 8 / 1.9438444924406,
                            timestamp: new Date(now - 2_000).toISOString(),
                            $source: 'nmea.wind',
                        },
                    },
                },
            },
            () => now,
        )!;
        expect(bus).not.toBeNull();
        bus.extra = { ...bus.extra, ...record.extra(now), wind_history_identity: 'pi-serene-summer' };
        const body = buildTelemetryBody(bus, 'calypso');
        const relayed = parseTelemetryBody(body, now);
        expect(relayed.ok).toBe(true);
        if (!relayed.ok) throw new Error(relayed.error);

        for (const [wire, via] of [
            [body, 'lan'],
            [relayed.row, 'cloud'],
        ] as const) {
            const reading = snapshotFromWire({ ...wire }, via);
            expect(reading?.snapshot.windHistory).toMatchObject({
                max1h: { kts: 31, at: now - 3_000_000 },
                gust10m: { kts: 19, at: now - 300_000 },
                sampleCount: 3,
            });
            expect(reading?.snapshot.windSampleAt).toBe(now - 2_000);
            expect(reading?.snapshot.windSampleSource).toBe('nmea.wind');
            expect(reading?.snapshot.windHistoryIdentity).toBe('pi-serene-summer');
        }
    });

    it('does not turn a current GPS/row clock into wind history on an older Pi payload', () => {
        const reading = snapshotFromWire(
            { source: 'pi', reported_at: new Date(now).toISOString(), tws_kts: 14 },
            'lan',
        );
        expect(reading?.snapshot.twsKts).toBe(14);
        expect(reading?.snapshot.windSampleAt).toBeUndefined();
        expect(reading?.snapshot.windHistory).toBeUndefined();
    });

    it('does not accept a phone publisher as the boat’s always-on wind recorder', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const record = new RollingWindHistory();
        record.ingest({ source: 'nmea.wind', kts: 5, at: now }, now);
        const reading = snapshotFromWire(
            { source: 'device', reported_at: new Date(now).toISOString(), extra: record.extra(now) },
            'cloud',
        );
        expect(reading?.snapshot.windHistory).toBeUndefined();
    });

    it('cannot record an unidentified wind sensor into a named sensor’s history', () => {
        const bus = readTelemetrySnapshot(
            { environment: { wind: { speedTrue: { value: 8, timestamp: new Date(now).toISOString() } } } },
            () => now,
        )!;
        expect(bus.twsKts).toBeGreaterThan(0);
        expect(bus.extra?.wind_tws_at_ms).toBeUndefined();
        expect(bus.extra?.wind_tws_source).toBeUndefined();
    });
});
