// Fictional data only: open water in the Tasman and a made-up 2030 calendar.
import { encodeSeabedCsv, SEABED_CSV_HEADER, type SeabedRow } from '../_shared/seabedCore.ts';
import { basicIso, gunzipCapped, gzip, loggerRefuses, objectPath, prepareBatch, sha256Hex } from './ingest.ts';
import { ownedActiveBoat, piBoat, type QueryClient } from './who.ts';

function assertEquals(actual: unknown, expected: unknown, note = ''): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    throw new Error(`${note} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

const NOW = Date.UTC(2030, 0, 2);
const T0 = Date.UTC(2030, 0, 1, 3, 0, 0);

function rows(count: number, lat0 = -30.5): SeabedRow[] {
    return Array.from({ length: count }, (_, i) => ({
        lon: 160.2,
        lat: lat0 + i * 0.00003,
        depth: 40 + i * 0.01,
        timeMs: T0 + i * 1000,
        sogKn: 6,
        cogDeg: 0,
        hdgDeg: null,
        heelDeg: null,
        fixQ: 1,
        hdop: 0.8,
        sats: 10,
        posAgeMs: 100,
        depthRef: 'T' as const,
        flags: 0,
    }));
}

function b64(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

async function gzBody(csv: string, extra: Record<string, unknown> = {}) {
    const bytes = await gzip(csv);
    return { action: 'batch', encoding: 'gzip', csv_b64: b64(bytes), sha256: await sha256Hex(bytes), ...extra };
}

Deno.test('a clean batch is stored as sent, with every index figure from the file', async () => {
    const csv = encodeSeabedCsv(rows(120));
    const body = await gzBody(csv, { meta: { device: 'pi', mmsi: '1' }, counters: { trim_dropped: 4 } });
    const out = await prepareBatch(body, [], NOW);
    if (!out.ok) throw new Error(out.error);
    assertEquals(out.rowCount, 120);
    assertEquals(out.privacyDropped, 0);
    assertEquals(out.contentSha256, body.sha256);
    assertEquals(b64(out.gz), body.csv_b64, 'stored bytes are the bytes sent');
    assertEquals(out.summary?.t_start, '2030-01-01T03:00:00.000Z');
    assertEquals(out.meta, { device: 'pi' }, 'unknown meta keys are dropped');
    assertEquals(out.counters.trim_dropped, 4);
});

Deno.test('the header must be exact and one bad row fails the whole batch', async () => {
    const swapped = encodeSeabedCsv(rows(10)).replace('LON,LAT', 'LAT,LON');
    const a = await prepareBatch(await gzBody(swapped), [], NOW);
    assertEquals(a.ok ? 0 : a.status, 422, 'header');
    const lines = encodeSeabedCsv(rows(10)).split('\n');
    lines[5] = lines[5].replace('-30.', '-95.');
    const b = await prepareBatch(await gzBody(lines.join('\n')), [], NOW);
    assertEquals(b.ok ? 0 : b.status, 422, 'bad row');
    const c = await prepareBatch(await gzBody(`${SEABED_CSV_HEADER}\n`), [], NOW);
    assertEquals(c.ok ? 0 : c.status, 422, 'no rows');
});

Deno.test('a sha256 that does not match the bytes is refused', async () => {
    const body = await gzBody(encodeSeabedCsv(rows(5)), { sha256: 'a'.repeat(64) });
    const out = await prepareBatch(body, [], NOW);
    assertEquals(out.ok ? 0 : out.status, 422);
});

Deno.test('rows inside a zone are dropped here too, and the stored file is re-encoded', async () => {
    const all = rows(200);
    const zone = { id: 'z', kind: 'marked' as const, lat: all[0].lat, lon: 160.2, radius_m: 250, jitter_m: 62.5 };
    const body = await gzBody(encodeSeabedCsv(all));
    const out = await prepareBatch(body, [zone], NOW);
    if (!out.ok) throw new Error(out.error);
    if (out.privacyDropped < 50) throw new Error(`only ${out.privacyDropped} rows dropped`);
    assertEquals(out.rowCount + out.privacyDropped, 200);
    assertEquals(out.contentSha256, body.sha256, 'the idempotency key stays the bytes the device sent');
    const stored = new TextDecoder().decode((await gunzipCapped(out.gz, 2_000_000)) as Uint8Array);
    assertEquals(stored.trimEnd().split('\n').length - 1, out.rowCount, 'stored rows');
});

Deno.test('an identity upload is accepted and stored gzipped', async () => {
    const csv = encodeSeabedCsv(rows(30));
    const bytes = new TextEncoder().encode(csv);
    const out = await prepareBatch({ encoding: 'identity', csv_b64: b64(bytes) }, [], NOW);
    if (!out.ok) throw new Error(out.error);
    const back = new TextDecoder().decode((await gunzipCapped(out.gz, 2_000_000)) as Uint8Array);
    assertEquals(back, csv);
});

Deno.test('object names carry owner, anonymous id, year, start and a hash prefix', () => {
    assertEquals(basicIso('2030-01-01T03:00:00.000Z'), '20300101T030000Z');
    const path = objectPath(
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-0000000000aa',
        { t_start: '2030-01-01T03:00:00.000Z' } as Parameters<typeof objectPath>[2],
        'abcdef0123456789',
    );
    assertEquals(
        path,
        '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000aa/2030/20300101T030000Z_abcdef01.csv.gz',
    );
});

/** A tiny stand-in for the supabase-js query builder: from(t).select().eq()...maybeSingle(). */
function fakeDb(tables: Record<string, Record<string, unknown>[]>): QueryClient {
    return {
        from(table: string) {
            const filters: [string, unknown][] = [];
            const builder = {
                select: () => builder,
                eq: (k: string, v: unknown) => (filters.push([k, v]), builder),
                is: (k: string, v: unknown) => (filters.push([k, v]), builder),
                maybeSingle: () => {
                    const hit = (tables[table] ?? []).find((r) => filters.every(([k, v]) => (r[k] ?? null) === v));
                    return Promise.resolve({ data: hit ?? null, error: null });
                },
            };
            return builder;
        },
    };
}

const OWNER = '00000000-0000-4000-8000-000000000001';
const STRANGER = '00000000-0000-4000-8000-000000000002';
const BOAT = '00000000-0000-4000-8000-0000000000b1';
const SOLD = '00000000-0000-4000-8000-0000000000b2';

const db = fakeDb({
    boats: [
        { id: BOAT, owner_id: OWNER, archived_at: null },
        { id: SOLD, owner_id: OWNER, archived_at: '2030-01-01T00:00:00Z' },
    ],
    pi_diary_relays: [
        { relay_id: 'relay-with-boat-0001', boat_id: BOAT },
        { relay_id: 'relay-without-boat-01', boat_id: null },
    ],
    user_active_vessels: [{ user_id: OWNER, boat_id: BOAT }],
});

Deno.test('a phone names a boat: its own active boat passes, a stranger or a released hull does not', async () => {
    assertEquals(await ownedActiveBoat(db, OWNER, BOAT), { ok: true, value: BOAT });
    assertEquals(await ownedActiveBoat(db, STRANGER, BOAT), { ok: true, value: null }, 'stranger');
    assertEquals(await ownedActiveBoat(db, OWNER, SOLD), { ok: true, value: null }, 'released');
    assertEquals(await ownedActiveBoat(db, OWNER, 'not-a-uuid'), { ok: true, value: null }, 'junk');
});

Deno.test('a Pi resolves to the hull on its pairing, else the owner active vessel', async () => {
    assertEquals(await piBoat(db, OWNER, 'relay-with-boat-0001'), { ok: true, value: BOAT });
    assertEquals(await piBoat(db, OWNER, 'relay-without-boat-01'), { ok: true, value: BOAT });
    assertEquals(await piBoat(db, STRANGER, 'relay-without-boat-01'), { ok: true, value: null });
});

Deno.test('one logger per boat: the other device may still send what it logged before the switch', () => {
    const changed = '2030-01-01T06:00:00.000Z';
    const before = '2030-01-01T05:59:00.000Z';
    const after = '2030-01-01T06:30:00.000Z';
    const phone = 'deviceBBBBBBBBBBBBBBBB';
    assertEquals(loggerRefuses('pi', null, changed, after), false, 'the Pi is the logger');
    assertEquals(loggerRefuses('phone', phone, changed, after), false, 'a phone is the logger');
    assertEquals(loggerRefuses('pi', phone, changed, after), true, 'the Pi after a phone took over');
    assertEquals(loggerRefuses('pi', phone, changed, before), false, 'the Pi uploading what it held');
    assertEquals(loggerRefuses('phone', null, changed, after), true, 'a phone after the Pi took over');
    assertEquals(loggerRefuses('phone', null, changed, before), false);
    assertEquals(loggerRefuses('phone', null, null, after), true, 'no change time known: only the logger');
});
