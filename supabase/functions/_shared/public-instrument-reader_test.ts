import { readPublicInstrumentAuthority, readPublicInstruments } from './public-instrument-reader.ts';

function equal(actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}
const config = { owner_id: 'owner-a', boat_id: 'boat-a', public_instruments_enabled: true };
function database(
    options: { hiddenError?: boolean; activeError?: boolean; activeId?: string; hidden?: string[]; boat?: string } = {},
) {
    const calls: Array<[string, string, unknown]> = [];
    const now = Date.now();
    const rows: Record<string, { data: unknown; error: unknown }> = {
        voyage_log_hidden_voyages: {
            data: (options.hidden ?? []).map((voyage_id) => ({ voyage_id })),
            error: options.hiddenError ? { message: 'unavailable' } : null,
        },
        voyages: {
            data: options.activeId ? { id: options.activeId, departure_time: '2000-01-01' } : null,
            error: options.activeError ? { message: 'multiple active rows' } : null,
        },
        vessel_telemetry: {
            data: {
                boat_id: options.boat ?? 'boat-a',
                reported_at: new Date(now).toISOString(),
                lat: -27,
                lon: 153,
                heel_deg: 0.5,
                pitch_deg: 2.75,
                extra: { heel_at: now, pitch_at: now, position_at: now, private: 'secret' },
            },
            error: null,
        },
    };
    const db = {
        from(table: string) {
            if (!rows[table]) throw new Error(`Unexpected expensive table ${table}`);
            calls.push([table, 'from', null]);
            const query = {
                select(_columns: string) {
                    return query;
                },
                eq(column: string, value: unknown) {
                    calls.push([table, column, value]);
                    return query;
                },
                maybeSingle() {
                    return Promise.resolve(rows[table]);
                },
                then(resolve: (row: unknown) => unknown) {
                    return Promise.resolve(rows[table]).then(resolve);
                },
            };
            return query;
        },
    } as unknown as Parameters<typeof readPublicInstrumentAuthority>[0];
    return { db, calls };
}

Deno.test('fast instruments work at berth, return only the allowlist, and query only the configured owner/boat', async () => {
    const { db, calls } = database();
    const result = await readPublicInstruments(
        db,
        config,
        'latest',
        await readPublicInstrumentAuthority(db, 'owner-a'),
        () => 'Australia/Brisbane',
    );
    equal(result.instruments_shared, true);
    equal(result.instruments?.heel, 0.5);
    equal(result.instruments?.pitch, 2.75);
    equal(result.instruments?.ship_time_zone, 'Australia/Brisbane');
    for (const key of ['lat', 'lon', 'extra', 'boat_id', 'owner_id']) equal(key in result.instruments!, false);
    equal(calls.filter((call) => call[1] === 'user_id').map((call) => call[2]), ['owner-a', 'owner-a']);
    equal(calls.filter((call) => call[0] === 'vessel_telemetry' && call[1] !== 'from'), [
        ['vessel_telemetry', 'owner_id', 'owner-a'],
        ['vessel_telemetry', 'boat_id', 'boat-a'],
    ]);
});

Deno.test('unreadable/hidden active authority denies instruments even for old active voyages', async () => {
    for (const options of [{ hiddenError: true }, { activeError: true }, { activeId: 'hidden', hidden: ['hidden'] }]) {
        const { db, calls } = database(options);
        const result = await readPublicInstruments(
            db,
            config,
            'latest',
            await readPublicInstrumentAuthority(db, 'owner-a'),
            () => 'Australia/Brisbane',
        );
        equal(result.instruments_shared, false);
        equal(result.instruments, null);
        equal(calls.some((call) => call[0] === 'vessel_telemetry'), false);
    }
});

Deno.test('absent consent/boat and every explicit history mode deny before telemetry lookup', async () => {
    for (
        const [settings, trip] of [
            [{ ...config, public_instruments_enabled: false }, 'latest'],
            [{ ...config, boat_id: null }, 'latest'],
            [config, 'all-diary'],
            [config, 'active-id'],
        ] as const
    ) {
        const { db, calls } = database();
        const result = await readPublicInstruments(
            db,
            settings,
            trip,
            await readPublicInstrumentAuthority(db, 'owner-a'),
            () => 'Australia/Brisbane',
        );
        equal(result.instruments_shared, false);
        equal(result.instruments, null);
        equal(calls.some((call) => call[0] === 'vessel_telemetry'), false);
    }
});

Deno.test('a mismatched boat row is never published', async () => {
    const { db } = database({ boat: 'boat-b' });
    const result = await readPublicInstruments(
        db,
        config,
        'latest',
        await readPublicInstrumentAuthority(db, 'owner-a'),
        () => 'Australia/Brisbane',
    );
    equal(result.instruments, null);
});
