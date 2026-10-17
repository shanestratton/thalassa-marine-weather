// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    CURRENT_FIELDS,
    DAILY_FIELDS,
    FIELD_UNITS,
    HOURLY_FIELDS,
    rawStoredModel,
    storedModel,
    validateRow,
} from '../supabase/functions/wx-publisher/contract';
import { handlePublisherRequest, tokenHash } from '../supabase/functions/wx-publisher/handler';

const NOW = Date.parse('2026-10-16T01:00:00Z');
const TOKEN = 'a'.repeat(64);
const REST = 'https://pcisdplnodrphauixcau.supabase.co/rest/v1';
function units(fields: readonly string[], current = false): Record<string, string> {
    return {
        time: 'iso8601',
        ...(current ? { interval: 'seconds' } : {}),
        ...Object.fromEntries(fields.map((field) => [field, FIELD_UNITS[field]])),
    };
}
function row(run = '2026-10-15T18:00:00Z') {
    const hourly: Record<string, unknown> = {
        time: Array.from({ length: 48 }, (_, i) =>
            new Date(NOW - 3600_000 + i * 3600_000).toISOString().replace('.000Z', 'Z'),
        ),
    };
    for (const field of HOURLY_FIELDS)
        hourly[field] = Array(48).fill(
            ['wind_speed_10m', 'wind_direction_10m'].includes(field) ? 0 : field === 'temperature_2m' ? 20 : null,
        );
    const current: Record<string, unknown> = { time: '2026-10-16T01:00:00Z', interval: 900 };
    for (const field of CURRENT_FIELDS)
        current[field] = ['wind_speed_10m', 'wind_direction_10m'].includes(field)
            ? 0
            : field === 'temperature_2m'
              ? 20
              : null;
    const daily: Record<string, unknown> = { time: ['2026-10-16', '2026-10-17'] };
    for (const field of DAILY_FIELDS) daily[field] = Array(2).fill(null);
    return {
        cell_id: '-2050_14850',
        model: 'ecmwf_ifs025',
        run_at: run,
        payload: {
            latitude: -20.25,
            longitude: 148.75,
            timezone: 'UTC',
            utc_offset_seconds: 0,
            current,
            hourly,
            daily,
            current_units: units(CURRENT_FIELDS, true),
            hourly_units: units(HOURLY_FIELDS),
            daily_units: units(DAILY_FIELDS),
            thalassa_provenance: {
                version: 2,
                source: 'wx',
                model: 'ecmwf_ifs025',
                cell_selection: 'sea',
                sampling: 'cell-centre',
                cell_id: '-2050_14850',
                cell_degrees: 0.25,
                latitude: -20.375,
                longitude: 148.625,
                run_at: run,
                source_domains: ['ecmwf_ifs025'],
                source_runs: [{ domain: 'ecmwf_ifs025', run_at: run, data_end_at: '2026-10-30T23:00:00Z' }],
            },
        },
    };
}
function request(body: unknown, token = TOKEN) {
    return new Request('https://example.com/wx-publisher', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
function database() {
    const stored = new Map<string, Record<string, unknown>>();
    const calls: { url: URL; method: string; headers: Headers; redirect?: RequestRedirect }[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method || 'GET',
            headers = new Headers(init?.headers);
        calls.push({ url, method, headers, redirect: init?.redirect });
        const respond = (data: unknown) =>
            new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        if (url.pathname.endsWith('wx_subscriptions')) return respond([{ cell_id: '-2050_14850' }]);
        if (method === 'GET')
            return respond([...stored.values()].map(({ cell_id, model, run_at }) => ({ cell_id, model, run_at })));
        const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (method === 'POST') {
            expect(headers.get('Prefer')).toContain('resolution=ignore-duplicates');
            const key = data.cell_id + '/' + data.model;
            if (stored.has(key)) return respond([]);
            stored.set(key, structuredClone(data));
            return respond([{ cell_id: data.cell_id, model: data.model, run_at: data.run_at }]);
        }
        expect(method).toBe('PATCH');
        const key = url.searchParams.get('cell_id')!.slice(3) + '/' + url.searchParams.get('model')!.slice(3);
        const previous = stored.get(key);
        const cutoff = Date.parse(url.searchParams.get('run_at')!.slice(3));
        if (!previous || Date.parse(String(previous.run_at)) >= cutoff) return respond([]);
        stored.set(key, { ...previous, ...data });
        return respond([{ cell_id: previous.cell_id, model: previous.model, run_at: data.run_at }]);
    };
    return { stored, calls, fetcher: fetcher as typeof fetch };
}
async function options(db = database()) {
    return {
        tokenHash: await tokenHash(TOKEN),
        restBase: REST,
        serviceKey: 'test-internal-only',
        fetch: db.fetcher,
        now: () => NOW,
    };
}

describe('dedicated wx publisher boundary', () => {
    it('rejects missing/wrong auth without any privileged request', async () => {
        const db = database(),
            config = await options(db);
        expect((await handlePublisherRequest(request({ action: 'work' }, 'b'.repeat(64)), config)).status).toBe(401);
        expect((await handlePublisherRequest(new Request('https://example.com'), config)).status).toBe(401);
        expect(db.calls).toHaveLength(0);
    });
    it('fails closed until the public verifier is provisioned', async () => {
        const db = database();
        expect(
            (await handlePublisherRequest(request({ action: 'work' }), { ...(await options(db)), tokenHash: '' }))
                .status,
        ).toBe(503);
        expect(db.calls).toHaveLength(0);
    });
    it('paginates only recent coarse subscriptions and returns versions without payloads', async () => {
        const db = database();
        const response = await handlePublisherRequest(
            request({ action: 'work', after: '-2100_14800', limit: 1 }),
            await options(db),
        );
        const result = await response.json();
        expect(result.cells[0]).toEqual({ cell_id: '-2050_14850', latitude: -20.375, longitude: 148.625, runs: {} });
        expect(result.next_cursor).toBe('-2050_14850');
        expect(db.calls[0].url.searchParams.get('last_seen_at')).toBe('gte.2026-10-13T01:00:00.000Z');
        expect(db.calls[0].url.searchParams.get('cell_id')).toBe('gt.-2100_14800');
        expect(db.calls[1].url.searchParams.get('select')).toBe('cell_id,model,run_at');
        expect(db.calls[1].url.searchParams.get('model')).toContain('wx2:ecmwf_ifs025');
        expect(db.calls.every((call) => call.redirect === 'error')).toBe(true);
        expect(JSON.stringify(result)).not.toContain('test-internal-only');
    });
    it('preserves real zero wind and null unavailable fields', async () => {
        const db = database();
        expect(
            (await handlePublisherRequest(request({ action: 'publish', rows: [row()] }), await options(db))).status,
        ).toBe(200);
        const saved = db.stored.get('-2050_14850/wx2:ecmwf_ifs025') as ReturnType<typeof row>;
        expect(saved.payload.hourly.wind_speed_10m).toEqual(Array(48).fill(0));
        expect(saved.payload.hourly.visibility).toEqual(Array(48).fill(null));
        expect(saved.model).toBe('wx2:ecmwf_ifs025');
        expect(saved.payload.thalassa_provenance.model).toBe('ecmwf_ifs025');
    });
    it('older or identical runs cannot overwrite a newer forecast or publication time', async () => {
        const db = database(),
            config = await options(db);
        await handlePublisherRequest(request({ action: 'publish', rows: [row('2026-10-15T21:00:00Z')] }), config);
        const before = structuredClone([...db.stored.values()]);
        const response = await handlePublisherRequest(request({ action: 'publish', rows: [row()] }), config);
        expect((await response.json()).results[0].status).toBe('unchanged');
        expect([...db.stored.values()]).toEqual(before);
        expect(db.calls.find((call) => call.method === 'PATCH')!.url.searchParams.get('run_at')).toBe(
            'lt.2026-10-15T18:00:00Z',
        );
    });
    it('concurrent old/new insertions retain the newer source run', async () => {
        const db = database(),
            config = await options(db);
        await Promise.all(
            [row(), row('2026-10-15T21:00:00Z')].map((item) =>
                handlePublisherRequest(request({ action: 'publish', rows: [item] }), config),
            ),
        );
        expect(db.stored.get('-2050_14850/wx2:ecmwf_ifs025')?.run_at).toBe('2026-10-15T21:00:00Z');
    });
    it('validates the whole batch before writing and refuses unsubscribed cells', async () => {
        const db = database(),
            config = await options(db);
        const bad = row();
        bad.model = 'ecmwf_ifs';
        expect((await handlePublisherRequest(request({ action: 'publish', rows: [row(), bad] }), config)).status).toBe(
            400,
        );
        expect(db.calls).toHaveLength(0);
        const other = row();
        other.cell_id = '-2075_14850';
        other.payload.thalassa_provenance.cell_id = other.cell_id;
        other.payload.thalassa_provenance.latitude = -20.625;
        expect((await handlePublisherRequest(request({ action: 'publish', rows: [other] }), config)).status).toBe(400);
        expect(db.calls.every((call) => call.method === 'GET')).toBe(true);
    });
    it('rejects excessive/duplicate rows and oversized bodies before any database call', async () => {
        const db = database(),
            config = await options(db);
        for (const rows of [[], Array.from({ length: 17 }, () => row()), [row(), row()]])
            expect((await handlePublisherRequest(request({ action: 'publish', rows }), config)).status).toBe(400);
        const big = request({ padding: 'x'.repeat(1024 * 1024) });
        expect((await handlePublisherRequest(big, config)).status).toBe(413);
        expect(db.calls).toHaveLength(0);
    });
    it('never echoes database errors or the internal service credential', async () => {
        const config = await options();
        config.fetch = (async () => {
            throw new Error('test-internal-only private upstream failure');
        }) as typeof fetch;
        const response = await handlePublisherRequest(request({ action: 'work' }), config);
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('test-internal-only');
    });
    it('leaves legacy raw-model rows untouched and returns raw model acknowledgements', async () => {
        const db = database(),
            config = await options(db);
        const legacy = { ...row(), published_at: '2026-10-15T18:05:00Z' };
        db.stored.set('-2050_14850/ecmwf_ifs025', structuredClone(legacy));
        const response = await handlePublisherRequest(request({ action: 'publish', rows: [row()] }), config);
        expect((await response.json()).results[0].model).toBe('ecmwf_ifs025');
        expect(db.stored.get('-2050_14850/ecmwf_ifs025')).toEqual(legacy);
        expect(db.stored.has('-2050_14850/wx2:ecmwf_ifs025')).toBe(true);
        expect(
            db.calls
                .filter((call) => call.method === 'PATCH')
                .every((call) => call.url.searchParams.get('model')?.startsWith('eq.wx2:')),
        ).toBe(true);
    });
    it('work recognises only approved wx2 keys and exposes their raw versions to Python', async () => {
        const db = database();
        for (const model of ['ecmwf_ifs025', 'wx2:ecmwf_ifs025', 'wx3:dwd_icon', 'wx2:ecmwf_ifs'])
            db.stored.set('-2050_14850/' + model, { cell_id: '-2050_14850', model, run_at: '2026-10-15T18:00:00Z' });
        const response = await handlePublisherRequest(request({ action: 'work' }), await options(db));
        expect((await response.json()).cells[0].runs).toEqual({ ecmwf_ifs025: '2026-10-15T18:00:00Z' });
        expect(storedModel('gfs_seamless')).toBe('wx2:gfs_seamless');
        for (const key of ['gfs_seamless', 'wx2:ecmwf_ifs', 'wx3:dwd_icon', 'wx2:wx2:dwd_icon'])
            expect(rawStoredModel(key)).toBeNull();
    });
    it('rejects unknown API control fields before privileged requests', async () => {
        const db = database(),
            config = await options(db);
        for (const body of [
            { action: 'work', table: 'profiles' },
            { action: 'publish', rows: [row()], callback: 'https://example.com' },
        ])
            expect((await handlePublisherRequest(request(body), config)).status).toBe(400);
        expect(db.calls).toHaveLength(0);
    });
});

describe('forecast source evidence', () => {
    it.each([
        'wrong-model',
        'wrong-cell',
        'future',
        'stale',
        'off-cycle',
        'knots',
        'naive-time',
        'duplicate-time',
        'null-wind',
        'wrong-domain',
        'wrong-oldest',
        'short-source',
        'shifted-grid',
    ])('rejects %s', (kind) => {
        const value = row();
        const p = value.payload,
            provenance = p.thalassa_provenance;
        if (kind === 'wrong-model') value.model = 'ecmwf_ifs';
        if (kind === 'wrong-cell') provenance.latitude += 0.01;
        if (kind === 'future') value.run_at = provenance.run_at = '2026-10-16T03:00:00Z';
        if (kind === 'stale') value.run_at = provenance.run_at = '2026-10-14T18:00:00Z';
        if (kind === 'off-cycle') value.run_at = provenance.run_at = '2026-10-15T18:01:00Z';
        if (kind === 'knots') p.hourly_units.wind_speed_10m = 'kn';
        if (kind === 'naive-time') (p.hourly.time as string[])[0] = '2026-10-16T00:00';
        if (kind === 'duplicate-time') (p.hourly.time as string[])[1] = (p.hourly.time as string[])[0];
        if (kind === 'null-wind') (p.hourly.wind_speed_10m as unknown[])[2] = null;
        if (kind === 'wrong-domain') provenance.source_domains = ['ncep_gfs025'];
        if (kind === 'wrong-oldest') provenance.source_runs[0].run_at = '2026-10-15T21:00:00Z';
        if (kind === 'short-source') provenance.source_runs[0].data_end_at = '2026-10-16T02:00:00Z';
        if (kind === 'shifted-grid') p.longitude = -64;
        expect(() => validateRow(value, NOW)).toThrow();
    });
});

describe('strict readings, units and whitelists', () => {
    it.each([
        ['wind_speed_10m', -1],
        ['wind_speed_10m', -99.9],
        ['wind_speed_10m', 601],
        ['wind_direction_10m', -1],
        ['wind_direction_10m', 361],
        ['relative_humidity_2m', -1],
        ['relative_humidity_2m', 101],
        ['cloud_cover', 101],
        ['pressure_msl', 101325],
        ['surface_pressure', 0],
        ['temperature_2m', -150],
        ['temperature_2m', 100],
        ['precipitation', -99.9],
        ['weather_code', -1],
        ['wind_speed_10m', ''],
        ['wind_speed_10m', '0'],
        ['wind_speed_10m', true],
    ])('rejects invalid hourly %s=%s without substituting calm', (field, bad) => {
        const value = row();
        (value.payload.hourly[String(field)] as unknown[])[2] = bad;
        expect(() => validateRow(value, NOW)).toThrow();
    });
    it('applies ranges to current and daily readings as well', () => {
        const current = row();
        current.payload.current.wind_speed_10m = -1;
        expect(() => validateRow(current, NOW)).toThrow();
        const daily = row();
        (daily.payload.daily.wind_direction_10m_dominant as unknown[])[0] = 500;
        expect(() => validateRow(daily, NOW)).toThrow();
    });
    it.each([
        'payload',
        'current',
        'hourly',
        'daily',
        'current_units',
        'hourly_units',
        'daily_units',
        'provenance',
        'source_run',
    ])('rejects unknown %s fields', (block) => {
        const value = row();
        const target =
            block === 'payload'
                ? value.payload
                : block === 'provenance'
                  ? value.payload.thalassa_provenance
                  : block === 'source_run'
                    ? value.payload.thalassa_provenance.source_runs[0]
                    : value.payload[block as 'current'];
        (target as Record<string, unknown>).unexpected = 'refuse';
        expect(() => validateRow(value, NOW)).toThrow();
    });
    it.each([
        ['current_units', 'pressure_msl', 'Pa'],
        ['hourly_units', 'relative_humidity_2m', 'fraction'],
        ['hourly_units', 'cloud_cover', 'fraction'],
        ['hourly_units', 'time', 'unixtime'],
        ['daily_units', 'precipitation_sum', 'inch'],
        ['daily_units', 'temperature_2m_min', '°F'],
        ['current_units', 'interval', 'minutes'],
        ['hourly_units', 'cape', 'joules'],
    ])('requires known %s %s units', (block, field, bad) => {
        const value = row();
        value.payload[block as 'current_units'][field] = bad;
        expect(() => validateRow(value, NOW)).toThrow();
    });
    it('allows issuer undefined units only for entirely unavailable null fields', () => {
        const value = row();
        value.payload.hourly_units.cape = 'undefined';
        expect(() => validateRow(value, NOW)).not.toThrow();
        (value.payload.hourly.cape as unknown[])[2] = 0;
        expect(() => validateRow(value, NOW)).toThrow();
    });
});
