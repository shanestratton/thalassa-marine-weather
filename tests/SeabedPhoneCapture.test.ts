/**
 * Seabed mapping on the phone: who may log, what a row is made of, and what
 * it costs the bridge. FICTIONAL tracks only (open water in the Tasman, a
 * made-up 2030 calendar): the repo is public.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    SeabedPhoneCapture,
    parseQueueFileName,
    seabedPhoneGate,
    type SeabedFiles,
    type SeabedGateInput,
} from '../services/seabed/SeabedPhoneCapture';
import { SeabedPhoneUploader } from '../services/seabed/SeabedUploader';
import {
    SEABED_CONSENT_VERSION,
    decodeSeabedCsv,
    distanceM,
    encodeSeabedCsv,
    encodeSeabedRow,
    type SeabedRow,
} from '../services/seabed/seabedCore';

const T0 = Date.UTC(2030, 0, 1, 2, 0, 0);
const DEVICE = 'device-abcdefghijklmnop';
const BOAT = '00000000-0000-4000-8000-0000000000b1';
const OTHER_BOAT = '00000000-0000-4000-8000-0000000000b2';
const M_PER_DEG_LAT = 111_195;

/** The rows a queued body carries. */
function bodyRows(text: string): { boat: string; recovered: unknown; rows: SeabedRow[] } {
    const body = JSON.parse(text);
    const csv = new TextDecoder().decode(Uint8Array.from(atob(body.csv_b64), (c) => c.charCodeAt(0)));
    const decoded = decodeSeabedCsv(csv, Infinity);
    if (!decoded.ok) throw new Error(decoded.error);
    return { boat: body.boat_id, recovered: body.meta.recovered, rows: decoded.rows };
}

function memoryFiles() {
    const files = new Map<string, { text: string; mtime: number }>();
    const calls = { append: 0, write: 0 };
    const store: SeabedFiles = {
        append: async (name, text) => {
            calls.append += 1;
            files.set(name, { text: (files.get(name)?.text ?? '') + text, mtime: T0 });
        },
        write: async (name, text) => {
            calls.write += 1;
            files.set(name, { text, mtime: T0 });
        },
        read: async (name) => files.get(name)?.text ?? null,
        remove: async (name) => {
            files.delete(name);
        },
        list: async () => [...files.entries()].map(([name, f]) => ({ name, size: f.text.length, mtime: f.mtime })),
    };
    return { files, calls, store };
}

function gateInput(over: Partial<SeabedGateInput> = {}): SeabedGateInput {
    return {
        local: {
            boatId: BOAT,
            enabled: true,
            consentVersion: SEABED_CONSENT_VERSION,
            captureDeviceId: DEVICE,
            zones: [],
            sounderNote: null,
            updatedAt: T0,
            pendingSync: false,
            dirty: [],
            known: true,
        },
        deviceId: DEVICE,
        activeBoatId: BOAT,
        piPaired: false,
        native: true,
        signedIn: true,
        full: false,
        ...over,
    };
}

/** DDMM.MMMM for NMEA. */
function nmeaCoord(value: number, degDigits: number): string {
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${String(deg).padStart(degDigits, '0')}${min.toFixed(4).padStart(7, '0')}`;
}

function rmc(lat: number, lon: number, sogKn: number, status = 'A'): string[] {
    return [
        '$GPRMC',
        '020000.00',
        status,
        nmeaCoord(lat, 2),
        lat < 0 ? 'S' : 'N',
        nmeaCoord(lon, 3),
        lon < 0 ? 'W' : 'E',
        sogKn.toFixed(1),
        '10.0',
        '010130',
        '',
        '',
    ];
}

const gga = (q: number, lat: number, lon: number) => [
    '$GPGGA',
    '020000.00',
    nmeaCoord(lat, 2),
    lat < 0 ? 'S' : 'N',
    nmeaCoord(lon, 3),
    lon < 0 ? 'W' : 'E',
    String(q),
    '11',
    '0.9',
    '1.0',
    'M',
];
const dbt = (m: number) => ['$SDDBT', (m / 0.3048).toFixed(1), 'f', m.toFixed(2), 'M', (m / 1.8288).toFixed(1), 'F'];
const dpt = (m: number, offset: string) => ['$SDDPT', m.toFixed(2), offset];

function rig(over: { connected?: () => boolean; armed?: boolean } = {}) {
    const mem = memoryFiles();
    let now = T0;
    const capture = new SeabedPhoneCapture({
        files: mem.store,
        now: () => now,
        connected: over.connected ?? (() => true),
        gzip: async (text) => ({ bytes: new TextEncoder().encode(text), encoding: 'identity' as const }),
        meta: () => ({ vessel_draft_m: 2.1 }),
    });
    capture.setZones([]);
    if (over.armed !== false) capture.arm(BOAT);
    /** One second of a boat sailing north at `kn`: RMC, GGA, then a sounding. */
    const second = (i: number, kn = 6, depth = 40 + (i % 5) * 0.1, lat0 = -30.5) => {
        now = T0 + i * 1000;
        const lat = lat0 + (i * kn * 0.514444) / 111_195;
        capture.onSentence('RMC', rmc(lat, 160.2, kn), now);
        capture.onSentence('GGA', gga(1, lat, 160.2), now + 5);
        capture.onSentence('DBT', dbt(depth), now + 40);
    };
    /** Feed a whole track, one second per point: RMC, GGA, then a sounding. */
    const sailTrack = (track: Array<{ t: number; lat: number; kn: number }>) => {
        for (const p of track) {
            now = p.t;
            capture.onSentence('RMC', rmc(p.lat, 160.2, p.kn), p.t);
            capture.onSentence('GGA', gga(1, p.lat, 160.2), p.t + 5);
            capture.onSentence('DBT', dbt(40 + (p.t % 7) * 0.1), p.t + 40);
        }
    };
    return { mem, capture, second, sailTrack, setNow: (t: number) => (now = t) };
}

/** Legs along the meridian: [metres north (negative = south), knots], then lying still for `still` seconds. */
function legs(startMs: number, startLat: number, plan: Array<[number, number]>, still: number) {
    const out: Array<{ t: number; lat: number; kn: number }> = [];
    let t = startMs;
    let lat = startLat;
    for (const [metres, kn] of plan) {
        const mPerS = kn * 0.514444;
        const steps = Math.round(Math.abs(metres) / mPerS);
        for (let i = 0; i < steps; i++) {
            lat += (Math.sign(metres) * mPerS) / M_PER_DEG_LAT;
            t += 1000;
            out.push({ t, lat, kn });
        }
    }
    for (let i = 1; i <= still; i++) out.push({ t: t + i * 1000, lat, kn: 0.2 });
    return out;
}

describe('who may log on this phone', () => {
    it('only the device the owner chose, on the current consent, with no Pi paired, on the native app', () => {
        expect(seabedPhoneGate(gateInput()).armed).toBe(true);
        expect(seabedPhoneGate(gateInput({ piPaired: true })).reason).toBe('pi');
        expect(seabedPhoneGate(gateInput({ deviceId: 'device-zzzzzzzzzzzzzzzz' })).reason).toBe('other-device');
        expect(seabedPhoneGate(gateInput({ native: false })).reason).toBe('web');
        expect(seabedPhoneGate(gateInput({ signedIn: false })).reason).toBe('signed-out');
        expect(seabedPhoneGate(gateInput({ full: true })).reason).toBe('full');
        const local = gateInput().local!;
        expect(seabedPhoneGate(gateInput({ local: { ...local, enabled: false } })).reason).toBe('off');
        expect(seabedPhoneGate(gateInput({ local: { ...local, consentVersion: '2020-01-01' } })).reason).toBe(
            'consent',
        );
        expect(seabedPhoneGate(gateInput({ local: { ...local, captureDeviceId: null } })).reason).toBe('pi');
        expect(seabedPhoneGate(gateInput({ local: null })).reason).toBe('off');
    });

    it("only for the owner's active boat: another boat, a boat no longer owned, or not known yet all stop it", () => {
        expect(seabedPhoneGate(gateInput({ activeBoatId: OTHER_BOAT })).reason).toBe('other-boat');
        expect(seabedPhoneGate(gateInput({ activeBoatId: null })).reason).toBe('not-owner');
        expect(seabedPhoneGate(gateInput({ activeBoatId: undefined })).reason).toBe('boat-unknown');
    });
});

describe('what a phone row is made of', () => {
    it('logs depth below the transducer at most once a second, from the bus position, with a batch when she stops', async () => {
        const r = rig();
        for (let i = 0; i <= 900; i++) r.second(i);
        expect(r.capture.stats().underway).toBe(true);
        // She stops: 60 s under 0.8 kn.
        for (let i = 901; i <= 965; i++)
            r.second(i, 0.2, 40, -30.5 + (900 * 6 * 0.514444) / 111_195 - (i * 0.2 * 0.514444) / 111_195);
        await r.capture.idle();
        const queued = [...r.mem.files.keys()].filter((n) => n.startsWith('q-'));
        expect(queued).toHaveLength(1);
        const body = JSON.parse(r.mem.files.get(queued[0])!.text);
        expect(body.device).toBe('phone');
        expect(body.encoding).toBe('identity');
        expect(body.meta.time_source).toBe('device-clock');
        expect(body.meta.position_source).toBe('nmea-gateway');
        const csv = new TextDecoder().decode(Uint8Array.from(atob(body.csv_b64), (c) => c.charCodeAt(0)));
        const decoded = decodeSeabedCsv(csv, Infinity);
        if (!decoded.ok) throw new Error(decoded.error);
        expect(decoded.rows.length).toBeGreaterThan(300);
        expect(decoded.rows.every((row) => row.depthRef === 'T' && row.fixQ === 1)).toBe(true);
        expect(r.mem.files.has('open.csv')).toBe(false);
    });

    it('a sounding with no position from the bus is no row, and is counted', () => {
        const r = rig();
        for (let i = 0; i <= 30; i++) r.second(i);
        r.setNow(T0 + 60_000);
        for (let i = 0; i < 5; i++) r.capture.onSentence('DBT', dbt(40), T0 + 60_000 + i * 1000);
        expect(r.capture.stats().counters.no_bus_fix).toBe(5);
    });

    it('takes the raw transducer depth from DPT, not the keel figure', () => {
        const r = rig();
        for (let i = 0; i <= 700; i++) {
            r.second(i);
        }
        const before = r.capture.stats().appended;
        r.capture.onSentence('DPT', dpt(4.76, '-1.8'), T0 + 701_500);
        expect(r.capture.stats().lastDepth).toBe(4.76);
        expect(r.capture.stats().appended).toBeGreaterThanOrEqual(before);
    });

    it('a DBT and a DPT in the same second make one row, not two', () => {
        const r = rig();
        for (let i = 0; i <= 30; i++) r.second(i);
        const before = r.capture.stats().counters.too_soon;
        r.capture.onSentence('DPT', dpt(40, ''), T0 + 30_100);
        expect(r.capture.stats().counters.too_soon).toBe(before + 1);
    });

    it('ignores everything while the gateway socket is not connected, or while not armed', () => {
        const off = rig({ connected: () => false });
        for (let i = 0; i <= 60; i++) off.second(i);
        expect(off.capture.stats().underway).toBe(false);
        const disarmed = rig({ armed: false });
        for (let i = 0; i <= 60; i++) disarmed.second(i);
        expect(disarmed.capture.stats().underway).toBe(false);
    });
});

describe('the boat a batch belongs to, and the end of a trip', () => {
    it('a batch keeps the boat the capture was armed for, even when it is re-armed for another', async () => {
        const r = rig();
        for (let i = 0; i <= 800; i++) r.second(i);
        r.capture.arm(OTHER_BOAT);
        await r.capture.idle();
        const queued = [...r.mem.files.keys()].filter((n) => n.startsWith('q-'));
        expect(queued).toHaveLength(1);
        expect(bodyRows(r.mem.files.get(queued[0])!.text).boat).toBe(BOAT);
        expect(r.capture.stats().armed).toBe(true);
    });

    it('nothing near where she stopped is queued, even after passing it an hour earlier and coming back', async () => {
        const r = rig();
        // 02:30: F at about 02:57, 2 km past it, back to F: the first pass over F closes with 02:xx.
        const track = legs(
            Date.UTC(2030, 0, 1, 2, 30, 0),
            -30.5 - 5000 / M_PER_DEG_LAT,
            [
                [5000, 6],
                [2000, 6],
                [-2000, 6],
            ],
            70,
        );
        r.sailTrack(track);
        await r.capture.idle();
        expect(r.capture.stats().underway).toBe(false);
        const end = track[track.length - 1];
        const names = [...r.mem.files.keys()];
        expect(names.filter((n) => n.startsWith('h-'))).toEqual([]);
        const queued = names.filter((n) => n.startsWith('q-'));
        expect(queued.length).toBeGreaterThanOrEqual(2);
        const rows = queued.flatMap((n) => bodyRows(r.mem.files.get(n)!.text).rows);
        expect(rows.length).toBeGreaterThan(1000);
        // 499.5, not 500: NMEA minutes to 4 places and the CSV's 6 decimals each move a fix ~0.1 m.
        expect(rows.every((row) => distanceM(row.lat, row.lon, end.lat, 160.2) >= 499.5)).toBe(true);
    });

    it('an hour closed mid-trip waits on the phone, counted, until the trip ends', async () => {
        const r = rig();
        const track = legs(Date.UTC(2030, 0, 1, 2, 50, 0), -30.5, [[6000, 6]], 0);
        r.sailTrack(track);
        await r.capture.idle();
        const held = [...r.mem.files.keys()].filter((n) => n.startsWith('h-'));
        expect(held).toHaveLength(1);
        expect(parseQueueFileName(held[0])?.rows).toBeGreaterThan(100);
        expect([...r.mem.files.keys()].filter((n) => n.startsWith('q-'))).toEqual([]);
    });

    it('after the app was killed, the open rows and held hours come back trimmed by where she was last', async () => {
        const r = rig({ armed: false });
        const row = (i: number, lat: number): SeabedRow => ({
            lon: 160.2,
            lat,
            depth: 40,
            timeMs: Date.UTC(2030, 0, 1, 2, 50, 0) + i * 1000,
            sogKn: 6,
            cogDeg: 0,
            hdgDeg: null,
            heelDeg: null,
            fixQ: 1,
            hdop: 0.9,
            sats: 11,
            posAgeMs: 40,
            depthRef: 'T',
            flags: 0,
        });
        const north = Array.from({ length: 600 }, (_, i) => row(i, -30.5 + (i * 3.0867) / M_PER_DEG_LAT));
        const turn = north[north.length - 1].lat;
        const south = Array.from({ length: 300 }, (_, i) => row(600 + i, turn - ((i + 1) * 3.0867) / M_PER_DEG_LAT));
        const csv = (rows: SeabedRow[]) => rows.map(encodeSeabedRow).join('\n') + '\n';
        await r.mem.store.write(
            `h-${north[0].timeMs}-0000000a-600-1852.json`,
            JSON.stringify({ v: 1, boat_id: BOAT, csv: encodeSeabedCsv(north), counters: {} }),
        );
        await r.mem.store.write(`open-${BOAT}.csv`, csv(south));
        await r.capture.recover();
        const names = [...r.mem.files.keys()];
        expect(names.filter((n) => n.startsWith('h-') || n.startsWith('open'))).toEqual([]);
        const bodies = names.filter((n) => n.startsWith('q-')).map((n) => bodyRows(r.mem.files.get(n)!.text));
        expect(bodies.length).toBeGreaterThanOrEqual(1);
        const end = south[south.length - 1];
        expect(bodies.every((b) => b.boat === BOAT && b.recovered === true)).toBe(true);
        const rows = bodies.flatMap((b) => b.rows);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((x) => distanceM(x.lat, x.lon, end.lat, end.lon) >= 499.5)).toBe(true);
    });
});

describe('what it costs the bridge', () => {
    it('writes the open batch once per 300 rows or five minutes, never once per sounding', async () => {
        const r = rig();
        for (let i = 0; i <= 1200; i++) r.second(i);
        await r.capture.idle();
        const rows = r.capture.stats().appended;
        expect(rows).toBeGreaterThan(600);
        expect(r.mem.calls.append).toBeLessThanOrEqual(Math.ceil(rows / 300) + 4);
        expect(r.mem.calls.append).toBeGreaterThan(0);
    });

    it('switching off ends the trip: held rows dropped, the open batch closed and queued', async () => {
        const r = rig();
        for (let i = 0; i <= 800; i++) r.second(i);
        await r.capture.finish();
        await r.capture.idle();
        expect([...r.mem.files.keys()].filter((n) => n.startsWith('q-'))).toHaveLength(1);
        expect(r.capture.stats().underway).toBe(false);
    });
});

describe('the phone uploader', () => {
    function upRig(replies: Array<{ status: number; body?: Record<string, unknown> } | null>) {
        const mem = memoryFiles();
        let now = T0;
        const posted: Record<string, unknown>[] = [];
        const withdrawn = vi.fn();
        const uploader = new SeabedPhoneUploader({
            files: mem.store,
            now: () => now,
            blocked: () => false,
            post: async (body) => {
                posted.push(body);
                const reply = replies.length ? replies.shift()! : { status: 200, body: { ok: true } };
                return reply === null ? null : { status: reply.status, body: reply.body ?? {} };
            },
            onWithdrawn: withdrawn,
            log: () => undefined,
        });
        const queue = async (n: number) => {
            for (let i = 0; i < n; i++) {
                await mem.store.write(
                    `q-${T0 + i}-0000000${i}.json`,
                    JSON.stringify({ device: 'phone', csv_b64: 'eA==' }),
                );
            }
        };
        return { mem, posted, uploader, queue, withdrawn, advance: (ms: number) => (now += ms) };
    }

    it('sends the oldest first and deletes each one when the function has it', async () => {
        const u = upRig([{ status: 200 }, { status: 200, body: { duplicate: true } }]);
        await u.queue(2);
        expect(await u.uploader.cycle()).toBe('sent');
        expect(u.posted.map((b) => b.action)).toEqual(['batch', 'batch']);
        expect(u.mem.files.size).toBe(0);
    });

    it('404 (not deployed yet) waits 12 hours without another request', async () => {
        const u = upRig([{ status: 404 }]);
        await u.queue(1);
        expect(await u.uploader.cycle()).toBe('not-deployed');
        u.advance(11 * 3_600_000);
        expect(await u.uploader.cycle()).toBe('waiting');
        expect(u.posted).toHaveLength(1);
        expect(u.mem.files.size).toBe(1);
    });

    it('409 not-enabled purges the queue and switches the phone off', async () => {
        const u = upRig([{ status: 409, body: { code: 'not-enabled' } }]);
        await u.queue(3);
        expect(await u.uploader.cycle()).toBe('not-enabled');
        expect(u.mem.files.size).toBe(0);
        expect(u.withdrawn).toHaveBeenCalledOnce();
    });

    it('422 keeps the batch aside as rejected and moves on', async () => {
        const u = upRig([{ status: 422, body: { error: 'bad time' } }, { status: 200 }]);
        await u.queue(2);
        await u.uploader.cycle();
        expect([...u.mem.files.keys()]).toEqual([expect.stringMatching(/^r-/)]);
    });

    it('403 not-owner (a boat since released) sets that batch aside and carries on with the rest', async () => {
        const u = upRig([{ status: 403, body: { code: 'not-owner' } }, { status: 200 }]);
        await u.queue(2);
        expect(await u.uploader.cycle()).toBe('sent');
        expect([...u.mem.files.keys()]).toEqual([expect.stringMatching(/^r-/)]);
    });

    it('409 not-logger (another device logs this boat now) waits six hours', async () => {
        const u = upRig([{ status: 409, body: { code: 'not-logger' } }]);
        await u.queue(2);
        expect(await u.uploader.cycle()).toBe('deferred');
        u.advance(5 * 3_600_000);
        expect(await u.uploader.cycle()).toBe('waiting');
        expect(u.posted).toHaveLength(1);
        expect(u.mem.files.size).toBe(2);
    });

    it('409 not-enabled also clears the held hours and the open rows', async () => {
        const u = upRig([{ status: 409, body: { code: 'not-enabled' } }]);
        await u.queue(1);
        await u.mem.store.write(`h-${T0}-0000000a-10-20.json`, '{}');
        await u.mem.store.write(`open-${BOAT}.csv`, 'x\n');
        await u.mem.store.write(`r-${T0}-0000000b.json`, '{}');
        expect(await u.uploader.cycle()).toBe('not-enabled');
        expect([...u.mem.files.keys()]).toEqual([`r-${T0}-0000000b.json`]);
    });

    it('offline: keeps everything and backs off', async () => {
        const u = upRig([null]);
        await u.queue(1);
        expect(await u.uploader.cycle()).toBe('unreachable');
        expect(u.mem.files.size).toBe(1);
        expect(u.uploader.nextDelayMs()).toBeGreaterThan(10 * 60_000);
    });
});
