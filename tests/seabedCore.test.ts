/**
 * Seabed mapping core — every rule a sounding is judged by, on FICTIONAL
 * tracks only (open ocean in the Tasman, a made-up 2030 calendar, and one
 * crossing of the antimeridian). The repo is public: no real position, track
 * or sounding from any boat belongs in here.
 */
import { describe, expect, it } from 'vitest';
import {
    BATCH_MAX_ROWS,
    SEABED_CSV_HEADER,
    SEABED_FLAG,
    SeabedCapture,
    captureFlags,
    cleanCaptureMeta,
    cleanCounters,
    closeRows,
    decodeSeabedCsv,
    distanceM,
    encodeSeabedCsv,
    insideAnyZone,
    jitterZoneCentre,
    markFrozen,
    markSpikes,
    newUnderwayState,
    parseSeabedZones,
    recoverTrip,
    stepUnderway,
    summariseRows,
    trimTripEnd,
    zoneMinRadiusM,
    type SeabedClosedBatch,
    type SeabedRow,
    type SeabedStep,
    type SeabedZone,
} from '../services/seabed/seabedCore';

const T0 = Date.UTC(2030, 0, 1, 0, 10, 0);
const NOW = Date.UTC(2030, 0, 2);
/** Fictional open water, far from any coast. */
const LAT0 = -30.5;
const LON0 = 160.2;
const M_PER_DEG_LAT = 111_195;

function row(over: Partial<SeabedRow> = {}): SeabedRow {
    return {
        lon: LON0,
        lat: LAT0,
        depth: 42.5,
        timeMs: T0,
        sogKn: 6,
        cogDeg: 0,
        hdgDeg: 2,
        heelDeg: null,
        fixQ: 1,
        hdop: 0.9,
        sats: 11,
        posAgeMs: 120,
        depthRef: 'T',
        flags: 0,
        ...over,
    };
}

/** A boat sailing due north at `kn` knots, one sounding a second. */
function northbound(count: number, kn = 6, startMs = T0, lat0 = LAT0): SeabedRow[] {
    const mPerS = kn * 0.514444;
    return Array.from({ length: count }, (_, i) =>
        row({ timeMs: startMs + i * 1000, lat: lat0 + (i * mPerS) / M_PER_DEG_LAT, sogKn: kn }),
    );
}

/** Get a capture under way at the first row's position (20 s at speed, no soundings). */
function underwayAt(capture: SeabedCapture, first: SeabedRow): void {
    for (let s = 0; s <= 20; s++) {
        capture.observe(first.timeMs - 20_000 + s * 1000, 6, { lat: first.lat, lon: first.lon });
    }
    expect(capture.underway).toBe(true);
}

/** Drive a whole track through observe + offer, returning every appended row and closed batch. */
function sail(capture: SeabedCapture, track: SeabedRow[]) {
    const appended: SeabedRow[] = [];
    const closed = [];
    for (const r of track) {
        const a = capture.observe(r.timeMs, r.sogKn, { lat: r.lat, lon: r.lon });
        const b = capture.offer(r);
        appended.push(...a.appended, ...b.appended);
        closed.push(...a.closed, ...b.closed);
    }
    return { appended, closed };
}

describe('CSV: the DCDB XYZ order first, values as captured', () => {
    it('starts with LON,LAT,DEPTH,TIME and round-trips 6-decimal positions and RFC3339 milliseconds', () => {
        expect(SEABED_CSV_HEADER.startsWith('LON,LAT,DEPTH,TIME,')).toBe(true);
        const rows = [
            row({ timeMs: T0 + 123, lon: 160.1234567, lat: -30.7654321 }),
            row({ timeMs: T0 + 1123, sogKn: null, hdop: null, sats: null, fixQ: null, posAgeMs: -40 }),
        ];
        const csv = encodeSeabedCsv(rows);
        const lines = csv.trimEnd().split('\n');
        expect(lines[0]).toBe(SEABED_CSV_HEADER);
        expect(lines[1].startsWith('160.123457,-30.765432,42.50,2030-01-01T00:10:00.123Z,')).toBe(true);
        expect(lines[2]).toContain(',,'); // unknown = empty, never zero
        const decoded = decodeSeabedCsv(csv, NOW);
        if (!decoded.ok) throw new Error(decoded.error);
        expect(decoded.rows).toHaveLength(2);
        expect(decoded.rows[0].timeMs).toBe(T0 + 123);
        expect(decoded.rows[0].lat).toBeCloseTo(-30.765432, 6);
        expect(decoded.rows[1].sogKn).toBeNull();
        expect(decoded.rows[1].posAgeMs).toBe(-40);
    });

    it('refuses a wrong header, a short row, an impossible position, time going backwards, the future and bad flags', () => {
        const good = encodeSeabedCsv([row(), row({ timeMs: T0 + 1000 })]);
        const swap = (from: string, to: string) => decodeSeabedCsv(good.replace(from, to), NOW);
        expect(decodeSeabedCsv(good.replace('LON,LAT', 'LAT,LON'), NOW).ok).toBe(false);
        expect(decodeSeabedCsv(`${SEABED_CSV_HEADER}\n1,2,3\n`, NOW).ok).toBe(false);
        expect(swap('-30.500000', '-91.000000').ok).toBe(false);
        expect(decodeSeabedCsv(encodeSeabedCsv([row({ timeMs: T0 + 5000 }), row()]), NOW).ok).toBe(false);
        expect(decodeSeabedCsv(encodeSeabedCsv([row({ timeMs: NOW + 10 * 60_000 })]), NOW).ok).toBe(false);
        expect(decodeSeabedCsv(encodeSeabedCsv([row({ flags: 4096 })]), NOW).ok).toBe(false);
        expect(decodeSeabedCsv(encodeSeabedCsv([row({ depthRef: 'X' as 'T' })]), NOW).ok).toBe(false);
        expect(decodeSeabedCsv(SEABED_CSV_HEADER + '\n', NOW).ok).toBe(false);
    });

    it('refuses more than 7200 rows in one batch', () => {
        const rows = Array.from({ length: 7201 }, (_, i) => row({ timeMs: T0 + i * 1000 }));
        const decoded = decodeSeabedCsv(encodeSeabedCsv(rows), NOW);
        expect(decoded.ok).toBe(false);
    });
});

describe('quality flags: recorded, never applied to the value', () => {
    it('sets each per-row flag at its threshold and leaves a clean row clean', () => {
        const F = SEABED_FLAG;
        expect(captureFlags(row())).toBe(0);
        expect(captureFlags(row({ fixQ: 0 })) & F.NO_FIX).toBeTruthy();
        expect(captureFlags(row({ fixQ: 6 })) & F.DR_FIX).toBeTruthy();
        expect(captureFlags(row({ posAgeMs: 2001 })) & F.POS_STALE).toBeTruthy();
        expect(captureFlags(row({ posAgeMs: -2001 })) & F.POS_STALE).toBeTruthy();
        expect(captureFlags(row({ posAgeMs: 2000 })) & F.POS_STALE).toBe(0);
        expect(captureFlags(row({ hdop: 4.1 })) & F.HDOP_HIGH).toBeTruthy();
        expect(captureFlags(row({ hdop: 4 })) & F.HDOP_HIGH).toBe(0);
        expect(captureFlags(row({ sogKn: 0.9 })) & F.SOG_LOW).toBeTruthy();
        expect(captureFlags(row({ sogKn: 25.1 })) & F.SOG_HIGH).toBeTruthy();
        expect(captureFlags(row({ depth: 0.4 })) & F.DEPTH_RANGE).toBeTruthy();
        expect(captureFlags(row({ depth: 1500.1 })) & F.DEPTH_RANGE).toBeTruthy();
        expect(captureFlags(row({ heelDeg: -21 })) & F.HEEL).toBeTruthy();
        expect(captureFlags(row({ flags: F.DEPTH_DERIVED })) & F.DEPTH_DERIVED).toBeTruthy();
    });

    it('marks a spike only with five or more neighbours, and keeps its depth', () => {
        const rows = northbound(21);
        rows[10].depth = 80;
        markSpikes(rows);
        expect(rows[10].flags & SEABED_FLAG.SPIKE).toBeTruthy();
        expect(rows[10].depth).toBe(80);
        expect(rows.filter((r) => r.flags & SEABED_FLAG.SPIKE)).toHaveLength(1);

        const few = northbound(5);
        few[2].depth = 80;
        markSpikes(few); // four neighbours: not enough to judge
        expect(few[2].flags & SEABED_FLAG.SPIKE).toBe(0);

        const gentle = northbound(21).map((r, i) => ({ ...r, depth: 40 + i * 0.3 }));
        markSpikes(gentle); // a sloping bottom is not a spike
        expect(gentle.some((r) => r.flags & SEABED_FLAG.SPIKE)).toBe(false);
    });

    it('marks a frozen sounder after 60 identical rows at 2 kn or more, not 59, not when slow', () => {
        const frozen = northbound(60, 4);
        markFrozen(frozen);
        expect(frozen.every((r) => r.flags & SEABED_FLAG.FROZEN)).toBe(true);
        const short = northbound(59, 4);
        markFrozen(short);
        expect(short.some((r) => r.flags & SEABED_FLAG.FROZEN)).toBe(false);
        const slow = northbound(80, 1.8);
        markFrozen(slow);
        expect(slow.some((r) => r.flags & SEABED_FLAG.FROZEN)).toBe(false);
        const varied = northbound(80, 4).map((r, i) => ({ ...r, depth: 42.5 + (i % 2) * 0.01 }));
        markFrozen(varied);
        expect(varied.some((r) => r.flags & SEABED_FLAG.FROZEN)).toBe(false);
    });
});

describe('under way: hysteresis between 1.5 kn and 0.8 kn', () => {
    it('starts after 20 s at 1.5 kn or more, not 19 s, and a dip restarts the clock', () => {
        const s = newUnderwayState();
        for (let t = 0; t < 19_000; t += 1000) expect(stepUnderway(s, t, 1.5, true)).toBeNull();
        expect(stepUnderway(s, 19_500, 1.2, true)).toBeNull(); // the dip
        for (let t = 20_000; t < 40_000; t += 1000) expect(stepUnderway(s, t, 2, true)).toBeNull();
        expect(stepUnderway(s, 40_000, 2, true)).toBe('start');
    });

    it('stops after 60 s under 0.8 kn, never at 0.9 kn, and after 30 s with no fix', () => {
        const s = newUnderwayState();
        for (let t = 0; t <= 20_000; t += 1000) stepUnderway(s, t, 3, true);
        expect(s.underway).toBe(true);
        for (let t = 21_000; t < 300_000; t += 1000) expect(stepUnderway(s, t, 0.9, true)).toBeNull();
        for (let t = 300_000; t < 360_000; t += 1000) expect(stepUnderway(s, t, 0.5, true)).toBeNull();
        expect(stepUnderway(s, 360_000, 0.5, true)).toBe('stop');

        const lost = newUnderwayState();
        for (let t = 0; t <= 20_000; t += 1000) stepUnderway(lost, t, 3, true);
        expect(stepUnderway(lost, 49_000, null, false)).toBeNull();
        expect(stepUnderway(lost, 50_000, null, false)).toBe('stop');
    });
});

describe('privacy zones', () => {
    const home: SeabedZone = { id: 'h', kind: 'home', lat: LAT0, lon: LON0, radius_m: 1000, jitter_m: 250 };

    it('keeps nothing inside a zone and counts what it dropped', () => {
        const capture = new SeabedCapture([home]);
        const track = northbound(600, 6); // ~1.85 km north from the zone centre
        underwayAt(capture, track[0]);
        const { appended } = sail(capture, track);
        expect(appended.length).toBeGreaterThan(0);
        expect(appended.every((r) => distanceM(r.lat, r.lon, LAT0, LON0) >= 1000)).toBe(true);
        expect(capture.counters.privacy_dropped).toBeGreaterThan(300);
    });

    it('moves a centre by at most a quarter of the radius, in every direction', () => {
        const extremes = [0, 0.25, 0.5, 0.75, 0.999999];
        for (const a of extremes) {
            for (const b of extremes) {
                const draws = [a, b];
                const moved = jitterZoneCentre(LAT0, LON0, 2000, () => draws.shift() as number);
                expect(distanceM(LAT0, LON0, moved.lat, moved.lon)).toBeLessThanOrEqual(500.01);
            }
        }
        const far = jitterZoneCentre(LAT0, LON0, 2000, () => 0.999999);
        expect(distanceM(LAT0, LON0, far.lat, far.lon)).toBeGreaterThan(499);
        expect(insideAnyZone(LAT0, LON0, [{ ...home, ...far, radius_m: 2000 }])).toBe(true);
    });

    it('accepts only well-formed zone lists: radius 250..5000 m, at most 20, one home', () => {
        expect(parseSeabedZones([home])).toEqual([home]);
        expect(parseSeabedZones([])).toEqual([]);
        expect(parseSeabedZones([{ ...home, radius_m: 249 }])).toBeNull();
        expect(parseSeabedZones([{ ...home, radius_m: 5001 }])).toBeNull();
        expect(parseSeabedZones([home, { ...home, id: 'h2' }])).toBeNull();
        expect(parseSeabedZones([{ ...home, kind: 'friend' }])).toBeNull();
        expect(parseSeabedZones([{ ...home, lat: 91 }])).toBeNull();
        expect(parseSeabedZones('nope')).toBeNull();
        const many = Array.from({ length: 21 }, (_, i) => ({ ...home, id: `m${i}`, kind: 'marked' }));
        expect(parseSeabedZones(many)).toBeNull();
    });

    it('keeps the jitter a zone was made with, and never lets the circle shrink off the true spot', () => {
        // A home made at 2 km moved its centre by up to 500 m: 0.5 km would leave the berth on the edge.
        const wide = { ...home, radius_m: 2000, jitter_m: 500 };
        expect(zoneMinRadiusM(wide)).toBe(667);
        expect(parseSeabedZones([wide])).toEqual([wide]);
        expect(parseSeabedZones([{ ...wide, radius_m: 666 }])).toBeNull();
        expect(parseSeabedZones([{ ...wide, radius_m: 667 }])).not.toBeNull();
        expect(zoneMinRadiusM({ jitter_m: 125 })).toBe(250); // never below the floor
        const { jitter_m: _dropped, ...withoutJitter } = home;
        expect(parseSeabedZones([withoutJitter])).toBeNull();
        expect(parseSeabedZones([{ ...home, jitter_m: -1 }])).toBeNull();
    });
});

describe('trip trimming: neither end of a trip is kept', () => {
    it('drops rows within 500 m of the start and the rows still held when she stops', () => {
        const capture = new SeabedCapture();
        const track = northbound(900, 6); // ~2.8 km
        underwayAt(capture, track[0]);
        const { appended } = sail(capture, track);
        // Nothing within 500 m of where the trip began.
        expect(appended.every((r) => distanceM(r.lat, r.lon, track[0].lat, track[0].lon) >= 500)).toBe(true);
        // While sailing, the last 500 m are still held, not written.
        const last = track[track.length - 1];
        expect(appended.every((r) => distanceM(r.lat, r.lon, last.lat, last.lon) > 500)).toBe(true);
        const held = capture.heldRows;
        expect(held).toBeGreaterThan(150);

        const stop = capture.finish();
        expect(stop.appended).toHaveLength(0); // held rows are dropped, never released
        expect(stop.closed).toHaveLength(1);
        expect(stop.closed[0].parked).toBe(false);
        expect(stop.tripEnd?.at).toEqual({ lat: last.lat, lon: last.lon });
        // ~162 rows inside 500 m of the start, plus every row still held.
        expect(stop.closed[0].counters.trim_dropped).toBeGreaterThan(held + 150);
    });

    it('a loop back keeps every row it already released, in time order', () => {
        const capture = new SeabedCapture();
        const out = northbound(600, 6);
        const lastOut = out[out.length - 1];
        const back = northbound(600, 6, lastOut.timeMs + 1000, lastOut.lat).map((r) => ({
            ...r,
            lat: lastOut.lat - (r.lat - lastOut.lat),
            cogDeg: 180,
        }));
        underwayAt(capture, out[0]);
        const appended = [...sail(capture, out).appended, ...sail(capture, back).appended];
        // Out ~1.85 km and back to the start: every row more than 500 m from the
        // start is kept once, on both legs, and nothing comes out of order.
        const far = [...out, ...back].filter((r) => distanceM(r.lat, r.lon, out[0].lat, out[0].lon) > 501);
        expect(Math.abs(appended.length - far.length)).toBeLessThanOrEqual(2);
        for (let i = 1; i < appended.length; i++) expect(appended[i].timeMs).toBeGreaterThan(appended[i - 1].timeMs);
        expect(appended.every((r) => distanceM(r.lat, r.lon, out[0].lat, out[0].lon) >= 500)).toBe(true);
    });

    it('closes a batch at each UTC hour and at 3600 rows, and marks a gap of more than 5 s', () => {
        const capture = new SeabedCapture();
        const start = Date.UTC(2030, 0, 1, 0, 50, 0);
        const track = northbound(1500, 8, start);
        underwayAt(capture, track[0]);
        const { closed, appended } = sail(capture, track);
        expect(closed).toHaveLength(1); // 00:xx rows closed when the first 01:xx row arrived
        expect(closed[0].parked).toBe(true); // mid-trip: held until the trip's end is known
        expect(new Date(closed[0].summary.t_end).getUTCHours()).toBe(0);
        expect(appended.length).toBeGreaterThan(closed[0].rows.length);

        const gappy = new SeabedCapture();
        const g = northbound(1200, 8);
        const holed = g.filter((_, i) => i < 600 || i > 606);
        underwayAt(gappy, holed[0]);
        const res = sail(gappy, holed);
        expect(res.appended.filter((r) => r.flags & SEABED_FLAG.GAP_BEFORE)).toHaveLength(1);
        expect(BATCH_MAX_ROWS).toBe(3600);
    });

    it('takes at most one row per 900 ms and ignores soundings while not under way', () => {
        const capture = new SeabedCapture();
        expect(capture.offer(row()).appended).toHaveLength(0);
        underwayAt(capture, row());
        capture.offer(row({ timeMs: T0 }));
        capture.offer(row({ timeMs: T0 + 500 }));
        expect(capture.counters.too_soon).toBe(1);
    });
});

/** A track along one meridian: legs of [metres north (negative = south), knots], one fix a second. */
function legs(startMs: number, startLat: number, plan: Array<[number, number]>): SeabedRow[] {
    const out: SeabedRow[] = [];
    let t = startMs;
    let lat = startLat;
    for (const [metres, kn] of plan) {
        const mPerS = kn * 0.514444;
        const steps = Math.round(Math.abs(metres) / mPerS);
        const dir = Math.sign(metres);
        for (let i = 0; i < steps; i++) {
            lat += (dir * mPerS) / M_PER_DEG_LAT;
            t += 1000;
            out.push(row({ timeMs: t, lat, sogKn: kn, cogDeg: dir > 0 ? 0 : 180 }));
        }
    }
    return out;
}

/** What a device does: final batches go to the queue, parked ones wait for the trip's end and are trimmed by it. */
function device() {
    const queued: SeabedClosedBatch[] = [];
    const parked: SeabedClosedBatch[] = [];
    const take = (step: SeabedStep) => {
        for (const b of step.closed) (b.parked ? parked : queued).push(b);
        if (step.tripEnd) {
            for (const p of parked.splice(0)) {
                const kept = trimTripEnd(p.rows, p.counters, step.tripEnd.at);
                if (kept) queued.push(kept);
            }
        }
    };
    return { queued, parked, take };
}

describe('the end of a trip, however she gets there', () => {
    const F = { lat: LAT0, lon: LON0 };
    const SOUTH_5KM = LAT0 - 5000 / M_PER_DEG_LAT;

    /** 5 km north to F, `past` metres beyond it, back to F, then lying still until the trip ends. */
    function overshoot(startMs: number, past: number) {
        const track = legs(startMs, SOUTH_5KM, [
            [5000, 6],
            [past, 6],
            [-past, 6],
        ]);
        const last = track[track.length - 1];
        for (let i = 1; i <= 70; i++) track.push(row({ timeMs: last.timeMs + i * 1000, lat: last.lat, sogKn: 0.2 }));
        return track;
    }

    function drive(startMs: number, past: number) {
        const capture = new SeabedCapture();
        const track = overshoot(startMs, past);
        underwayAt(capture, track[0]);
        const d = device();
        const parkedSeen: SeabedClosedBatch[] = [];
        for (const r of track) {
            for (const step of [capture.observe(r.timeMs, r.sogKn, { lat: r.lat, lon: r.lon }), capture.offer(r)]) {
                parkedSeen.push(...step.closed.filter((b) => b.parked));
                d.take(step);
            }
        }
        expect(capture.underway).toBe(false);
        const end = track[track.length - 1];
        expect(distanceM(end.lat, end.lon, F.lat, F.lon)).toBeLessThan(5);
        return { ...d, parkedSeen, end };
    }

    it('keeps nothing within 500 m of where she stopped, after sailing 900 m past it and coming back', () => {
        const { queued, parked, end } = drive(Date.UTC(2030, 0, 1, 2, 5, 0), 900); // the whole trip in one hour
        const rows = queued.flatMap((b) => b.rows);
        expect(parked).toHaveLength(0);
        expect(rows.length).toBeGreaterThan(1000);
        const nearest = Math.min(...rows.map((r) => distanceM(r.lat, r.lon, end.lat, end.lon)));
        expect(nearest).toBeGreaterThanOrEqual(500);
    });

    it('does the same when the first pass over the end spot closed with an earlier hour', () => {
        // 02:30 start: F at about 02:57; 2 km past it the 03:xx rows are released, so the
        // 02:xx batch (with the first pass over F in it) closes mid-trip, parked.
        const { queued, parked, parkedSeen, end } = drive(Date.UTC(2030, 0, 1, 2, 30, 0), 2000);
        expect(parkedSeen).toHaveLength(1);
        expect(parkedSeen[0].rows.some((r) => distanceM(r.lat, r.lon, end.lat, end.lon) < 500)).toBe(true);
        expect(parked).toHaveLength(0);
        expect(queued.length).toBeGreaterThanOrEqual(2);
        const rows = queued.flatMap((b) => b.rows);
        expect(rows.length).toBeGreaterThan(1000);
        expect(rows.every((r) => distanceM(r.lat, r.lon, end.lat, end.lon) >= 500)).toBe(true);
        expect(queued.every((b) => !b.parked)).toBe(true);
        const trimmed = queued.reduce((n, b) => n + b.counters.trim_dropped, 0);
        expect(trimmed).toBeGreaterThan(300);
    });

    it('after a restart, the trip ends where her last kept row was', () => {
        const parkedRows = northbound(600, 6, Date.UTC(2030, 0, 1, 2, 50, 0));
        const turnLat = parkedRows[parkedRows.length - 1].lat;
        const open = northbound(300, 6, Date.UTC(2030, 0, 1, 3, 0, 0), turnLat).map((r) => ({
            ...r,
            lat: turnLat - (r.lat - turnLat), // back the way she came
        }));
        const end = open[open.length - 1];
        const out = recoverTrip([{ rows: parkedRows, counters: cleanCounters({ privacy_dropped: 2 }) }], open);
        const rows = out.flatMap((b) => b.rows);
        expect(out.every((b) => !b.parked)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => distanceM(r.lat, r.lon, end.lat, end.lon) >= 500)).toBe(true);
        expect(out[0].counters.privacy_dropped).toBe(2);
        expect(recoverTrip([], [])).toEqual([]);
    });
});

describe('values the decoder would refuse never reach a batch', () => {
    it('empties an impossible optional value, drops a row with an impossible depth or time, and counts both', () => {
        const capture = new SeabedCapture();
        const track = northbound(900, 6);
        track[300] = { ...track[300], cogDeg: 360.5 };
        track[301] = { ...track[301], sogKn: -0.2 };
        track[302] = { ...track[302], heelDeg: 95 };
        track[303] = { ...track[303], hdop: 120 };
        track[304] = { ...track[304], sats: 300, fixQ: 9, posAgeMs: 1e9, hdgDeg: Number.NaN };
        track[305] = { ...track[305], depth: 13_000 };
        track[306] = { ...track[306], depth: Number.NaN };
        track[307] = { ...track[307], timeMs: Date.UTC(2006, 0, 1) };
        underwayAt(capture, track[0]);
        const { closed } = sail(capture, track);
        const stop = capture.finish();
        const batches = [...closed, ...stop.closed];
        const rows = batches.flatMap((b) => b.rows);
        const counters = batches.reduce(
            (sum, b) => ({
                cleared: sum.cleared + b.counters.fields_cleared,
                bad: sum.bad + b.counters.bad_values,
            }),
            { cleared: 0, bad: 0 },
        );
        expect(counters).toEqual({ cleared: 5, bad: 3 });
        for (const b of batches) {
            const decoded = decodeSeabedCsv(b.csv, NOW);
            if (!decoded.ok) throw new Error(decoded.error);
        }
        const r300 = rows.find((r) => r.timeMs === track[300].timeMs);
        expect(r300?.cogDeg).toBeNull();
        expect(r300?.depth).toBe(42.5); // the sounding itself is kept as captured
        expect(rows.find((r) => r.timeMs === track[301].timeMs)?.sogKn).toBeNull();
        expect(rows.some((r) => r.timeMs === track[305].timeMs)).toBe(false);
    });
});

describe('batch summary', () => {
    it('reports counts, time span, track length and the depth range of unflagged rows', () => {
        const rows = northbound(120, 6);
        rows[50].depth = 0.2;
        rows[50].flags = captureFlags(rows[50]); // DEPTH_RANGE, as offer() would set it
        const closed = closeRows(rows, cleanCounters({ privacy_dropped: 3, junk: 9 }));
        const s = closed.summary;
        expect(s.row_count).toBe(120);
        expect(s.rows_flagged).toBeGreaterThanOrEqual(1);
        expect(s.flag_counts.DEPTH_RANGE).toBe(1);
        expect(s.t_start).toBe('2030-01-01T00:10:00.000Z');
        expect(s.depth_min).toBe(42.5);
        expect(s.track_m).toBeGreaterThan(360);
        expect(s.track_m).toBeLessThan(375);
        expect(s.crosses_antimeridian).toBe(false);
        expect(closed.counters.privacy_dropped).toBe(3);
        expect(closed.rows[50].flags & SEABED_FLAG.SPIKE).toBeTruthy();
        expect(rows[50].flags & SEABED_FLAG.SPIKE).toBe(0); // closeRows works on a copy
    });

    it('describes a batch that crosses the antimeridian with its west edge east of its east edge', () => {
        const rows = Array.from({ length: 60 }, (_, i) => row({ timeMs: T0 + i * 1000, lon: 179.999 + i * 0.0001 }));
        const wrapped = rows.map((r) => ({ ...r, lon: r.lon > 180 ? r.lon - 360 : r.lon }));
        const s = summariseRows(wrapped);
        expect(s.crosses_antimeridian).toBe(true);
        expect(s.min_lon).toBeCloseTo(179.999, 6);
        expect(s.max_lon).toBeCloseTo(-179.9951, 4);
        expect(s.track_m).toBeLessThan(1000);
    });

    it('keeps only known, bounded metadata keys', () => {
        const meta = cleanCaptureMeta({
            device: 'pi',
            time_source: 'gnss',
            transducer_to_keel_m: 1.2,
            vessel_draft_m: 99,
            draft_confirmed: true,
            mmsi: '123456789',
            sounder_note: 'x'.repeat(121),
        });
        expect(meta).toEqual({ device: 'pi', time_source: 'gnss', transducer_to_keel_m: 1.2, draft_confirmed: true });
    });
});
