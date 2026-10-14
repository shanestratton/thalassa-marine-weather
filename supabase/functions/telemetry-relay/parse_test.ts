import { MAX_READING_AGE_MS, MAX_REPORT_AGE_MS, parseTelemetryBody } from './parse.ts';

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

// 129-08: a Pi whose bus went silent (its GPS clock stopped) still reaches the
// cloud, so the quiet-boat watchdog hears the Pi; the readings keep their own time.
Deno.test('a live post (sent_at) may carry readings whose own clock stalled, dated as they were', () => {
    const stalled = new Date(NOW - 40 * 60_000).toISOString();
    const parsed = parseTelemetryBody(
        {
            reported_at: stalled,
            sent_at: new Date(NOW - 2_000).toISOString(),
            lat: 59.91,
            lon: 10.75,
            extra: { bus_at_ms: NOW - 40 * 60_000 },
        },
        NOW,
    );
    if (!parsed.ok) throw new Error(parsed.error);
    assertEquals(parsed.row.reported_at, stalled, 'the reading keeps its own time');
    assertEquals(parsed.row.lat, 59.91);
    assertEquals(parsed.row.extra, { bus_at_ms: NOW - 40 * 60_000 });
    // The same body from an older Pi (no sent_at) is refused, as before.
    assertEquals(parseTelemetryBody({ reported_at: stalled }, NOW).ok, false);
});

Deno.test('sent_at must itself be live and not ahead; readings a month stale are refused; a bad sent_at is no sent_at', () => {
    const stalled = new Date(NOW - 40 * 60_000).toISOString();
    const late = parseTelemetryBody({
        reported_at: stalled,
        sent_at: new Date(NOW - MAX_REPORT_AGE_MS - 1_000).toISOString(),
    }, NOW);
    assertEquals(late, { ok: false, error: 'sent_at is too old to be live' });
    const ahead = parseTelemetryBody({ reported_at: stalled, sent_at: new Date(NOW + 5 * 60_000).toISOString() }, NOW);
    assertEquals(ahead, { ok: false, error: 'sent_at is in the future' });
    const ancient = parseTelemetryBody(
        { reported_at: new Date(NOW - MAX_READING_AGE_MS - 1_000).toISOString(), sent_at: new Date(NOW).toISOString() },
        NOW,
    );
    assertEquals(ancient, { ok: false, error: 'reported_at is too old to keep' });
    const future = parseTelemetryBody({
        reported_at: new Date(NOW + 5 * 60_000).toISOString(),
        sent_at: new Date(NOW).toISOString(),
    }, NOW);
    assertEquals(future, { ok: false, error: 'reported_at is in the future' });
    assertEquals(parseTelemetryBody({ reported_at: stalled, sent_at: 'soon' }, NOW).ok, false);
    const live = parseTelemetryBody({ reported_at: new Date(NOW - 1_000).toISOString(), sent_at: 'soon' }, NOW);
    assertEquals(live.ok, true);
});
