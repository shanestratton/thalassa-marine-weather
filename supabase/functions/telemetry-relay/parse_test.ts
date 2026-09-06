import { MAX_REPORT_AGE_MS, parseTelemetryBody } from './parse.ts';

function assertEquals(actual: unknown, expected: unknown, note = ''): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    throw new Error(`${note} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const NOW = Date.parse('2026-09-06T06:00:00Z');

Deno.test('a full snapshot is kept, one sick sensor is dropped to null, the rest survives', () => {
    const parsed = parseTelemetryBody(
        {
            reported_at: '2026-09-06T05:59:58Z',
            lat: -27.2,
            lon: 153.11,
            sog_kts: 6.2,
            cog_deg: 45,
            tws_kts: 4000, // a broken masthead unit
            twa_deg: -42,
            depth_m: 3.4,
            device_label: 'Calypso',
            extra: { battery_house_v: 12.9, 'bad key!': 1, engine_temp_c: 82 },
        },
        NOW,
    );
    if (!parsed.ok) throw new Error(parsed.error);
    assertEquals(parsed.row.source, 'pi');
    assertEquals(parsed.row.tws_kts, null, 'tws');
    assertEquals(parsed.row.twa_deg, -42, 'twa');
    assertEquals(parsed.row.depth_m, 3.4, 'depth');
    assertEquals(parsed.row.device_label, 'Calypso');
    assertEquals(parsed.row.extra, { battery_house_v: 12.9, engine_temp_c: 82 });
});

Deno.test('Null Island is not a position', () => {
    const parsed = parseTelemetryBody({ reported_at: '2026-09-06T05:59:58Z', lat: 0, lon: 0 }, NOW);
    if (!parsed.ok) throw new Error(parsed.error);
    assertEquals(parsed.row.lat, null);
    assertEquals(parsed.row.lon, null);
});

Deno.test('a stale or future report is refused, a missing timestamp too', () => {
    const old = parseTelemetryBody({ reported_at: new Date(NOW - MAX_REPORT_AGE_MS - 1000).toISOString() }, NOW);
    assertEquals(old.ok, false);
    const future = parseTelemetryBody({ reported_at: new Date(NOW + 5 * 60_000).toISOString() }, NOW);
    assertEquals(future.ok, false);
    assertEquals(parseTelemetryBody({}, NOW).ok, false);
});

Deno.test('only pi or device may claim to be the source', () => {
    assertEquals(parseTelemetryBody({ reported_at: '2026-09-06T05:59:58Z', source: 'cloud' }, NOW).ok, false);
    const device = parseTelemetryBody({ reported_at: '2026-09-06T05:59:58Z', source: 'device' }, NOW);
    if (!device.ok) throw new Error(device.error);
    assertEquals(device.row.source, 'device');
});
