/**
 * The Pi keeps the night watch (build 126, package 126-04a).
 *
 * The Pi grades every AIS target all night with the SAME rule the phone uses
 * (./collisionRule/collisionRule.ts, the app's utils/collisionRule.ts copied
 * verbatim by scripts/sync-collision-rule.mjs), latches encounters with the
 * phone's own numbers (COLLISION_RULE.latch), and listens for distress
 * beacons its own radio hears. Signal K here is a fake, shaped as Signal K
 * 2.32.0 files the boat and her targets; nothing touches a real Pi, a gateway
 * or port 1456.
 *
 * Fictional ships: own boat 'Kestrel' (MMSI 235000101), Nordlicht 211000001,
 * Bay Runner 366000002, a SART 970000003, an MOB beacon 972000004, an
 * EPIRB-AIS 974000005. Waters: the Solent, the Hauraki Gulf, Chesapeake Bay.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as rule from './collisionRule/collisionRule.js';
import { AisNightWatch, AIS_WATCH_MAX_ALARMS, AIS_WATCH_TICK_MS, type AisWatchKind } from './aisWatch.js';
import { fileAisWatchStore, type AisWatchStore } from './aisWatchStore.js';
import {
    SIGNALK_SHARED_CACHE_MS,
    SharedSignalkReader,
    readLanTelemetry,
    type SignalkDocuments,
} from './lanTelemetry.js';
import { TelemetryPublisher } from './telemetryPublisher.js';
import { createAisWatchRoutes } from './routes/aisWatch.js';

// ── Parity: the same cases as the app, through the MIRROR ──────────────────

interface ParityCase {
    name: string;
    fn: string;
    expect: unknown;
    [key: string]: unknown;
}
const PARITY = JSON.parse(
    fs.readFileSync(new URL('./collisionRule/parity.fixtures.json', import.meta.url), 'utf8'),
) as { cases: ParityCase[] };

const r3 = (x: unknown) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);

/** The same small runner tests/CollisionRulePiMirror.test.ts uses on the app module. */
function runParity(c: ParityCase): unknown {
    switch (c.fn) {
        case 'assessCollision': {
            const prefs = rule.sanitiseCollisionPrefs(c.prefs);
            const own = c.own as rule.CollisionOwnShip;
            const target = c.target as rule.CollisionTarget;
            const a = rule.assessCollision(own, target, prefs);
            if (!a) return null;
            return {
                risk: a.risk,
                closeQuarters: a.closeQuarters,
                pair: a.pair,
                alarm: a.alarm,
                rangeOnly: a.rangeOnly,
                reason: a.reason,
                rangeNm: r3(a.rangeNm),
                bearingDeg: r3(a.bearingDeg),
                cpaNm: r3(a.cpaNm),
                tcpaMin: r3(a.tcpaMin),
                opening: rule.collisionOpening(a, prefs),
                settled: rule.collisionSettled(a, own, rule.aisSogKn(target.sogKn)),
                soundsMuted: rule.collisionShouldSound(a, 1e15, 0),
            };
        }
        case 'classifyDistress':
            return rule.classifyDistress(c.evidence as rule.DistressEvidence);
        case 'collisionPairFor':
            return rule.collisionPairFor(c.ownSogKn as number | null, c.previous as rule.CollisionPairName | null);
        case 'aisSogKn':
            return rule.aisSogKn(c.value);
        case 'aisCogDeg':
            return rule.aisCogDeg(c.value);
        case 'aisHeadingDeg':
            return rule.aisHeadingDeg(c.value);
        case 'distressKindOfMmsi':
            return rule.distressKindOfMmsi(c.value);
        default:
            throw new Error(`no runner for ${c.fn}`);
    }
}

test('parity: every case gives the app’s answer through the Pi’s copy of the rule', () => {
    assert.ok(PARITY.cases.length >= 30);
    for (const c of PARITY.cases) assert.deepEqual(runParity(c), c.expect, c.name);
});

// ── A fake Signal K ────────────────────────────────────────────────────────

const T0 = Date.parse('2026-10-09T21:00:00Z');
const KN = 1 / 1.94384; // m/s per knot
const RAD = Math.PI / 180;
const OWN_MMSI = 235_000_101;
const NORDLICHT = 211_000_001;
const BAY_RUNNER = 366_000_002;
const SART = 970_000_003;
const MOB = 972_000_004;
const SELF_URN = `urn:mrn:imo:mmsi:${OWN_MMSI}`;
const PREFS = { offshore: { cpaNm: 0.5, tcpaMin: 15 }, inshore: { cpaNm: 0.2, tcpaMin: 6 } };

const SOLENT = { lat: 50.78, lon: -1.2 };
const HAURAKI = { lat: -36.75, lon: 174.95 };
const CHESAPEAKE = { lat: 37.9, lon: -76.2 };

function offset(at: { lat: number; lon: number }, bearingDeg: number, nm: number) {
    const b = bearingDeg * RAD;
    return {
        lat: at.lat + (nm * Math.cos(b)) / 60,
        lon: at.lon + (nm * Math.sin(b)) / (60 * Math.cos(at.lat * RAD)),
    };
}

const iso = (t: number) => new Date(t).toISOString();
const leaf = (value: unknown, at: number) => ({ value, timestamp: iso(at), $source: 'ydwg-tcp.AI' });

interface Ship {
    at: number;
    pos?: { lat: number; lon: number };
    sogKn?: number;
    cogDeg?: number;
    state?: string;
    name?: string;
}

/** A target as Signal K 2.32.0 files it: one report, every leaf with its time; nothing for 'not available'. */
function shipDoc(mmsi: number, s: Ship) {
    return {
        mmsi: String(mmsi),
        ...(s.name ? { name: s.name } : {}),
        navigation: {
            ...(s.pos ? { position: leaf({ latitude: s.pos.lat, longitude: s.pos.lon }, s.at) } : {}),
            ...(s.sogKn !== undefined ? { speedOverGround: leaf(s.sogKn * KN, s.at) } : {}),
            ...(s.cogDeg !== undefined ? { courseOverGroundTrue: leaf(s.cogDeg * RAD, s.at) } : {}),
            ...(s.state !== undefined ? { state: leaf(s.state, s.at) } : {}),
        },
    };
}

/** Our own boat's document (vessels/self), or one with no fix at all. */
function selfDoc(own: { at: number; pos?: { lat: number; lon: number }; sogKn?: number; cogDeg?: number }) {
    return {
        navigation: {
            ...(own.pos
                ? {
                      position: {
                          value: { latitude: own.pos.lat, longitude: own.pos.lon },
                          timestamp: iso(own.at),
                          $source: 'ydwg-tcp.GP',
                      },
                  }
                : {}),
            ...(own.sogKn !== undefined ? { speedOverGround: leaf(own.sogKn * KN, own.at) } : {}),
            ...(own.cogDeg !== undefined ? { courseOverGroundTrue: leaf(own.cogDeg * RAD, own.at) } : {}),
        },
    };
}

/** A whole Signal K answer: her own boat, and every target. */
function docs(
    now: number,
    own: { pos?: { lat: number; lon: number }; sogKn?: number; cogDeg?: number; at?: number } | null,
    ships: Record<number, Ship>,
): SignalkDocuments {
    const vessels: Record<string, unknown> = {
        [SELF_URN]: { name: 'Kestrel', navigation: {} },
    };
    for (const [mmsi, s] of Object.entries(ships)) vessels[`urn:mrn:imo:mmsi:${mmsi}`] = shipDoc(Number(mmsi), s);
    return {
        selfDoc: own === null ? null : selfDoc({ at: own.at ?? now - 1_000, ...own }),
        vesselsDoc: vessels,
        selfAnswer: `vessels.${SELF_URN}`,
        readAt: now,
    };
}

const SIGNALK_DOWN = (now: number): SignalkDocuments => ({
    selfDoc: null,
    vesselsDoc: null,
    selfAnswer: null,
    readAt: now,
});

/** A watch driven by hand: `world(t)` is what Signal K says at time t. */
function harness(opts: { atAnchor?: boolean; store?: AisWatchStore } = {}) {
    let t = T0;
    let world: (now: number) => SignalkDocuments = (now) => docs(now, null, {});
    let anchored = opts.atAnchor ?? false;
    const raised: string[] = [];
    const watch = new AisNightWatch({
        documents: async () => world(t),
        atAnchor: () => anchored,
        now: () => t,
        store: opts.store,
        onAlarm: (alarm) => raised.push(alarm.key),
        // Ticks are driven by the test, one pass at a time.
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    return {
        watch,
        raised,
        set world(fn: (now: number) => SignalkDocuments) {
            world = fn;
        },
        set anchored(v: boolean) {
            anchored = v;
        },
        get now() {
            return t;
        },
        /** Move the clock on and run one pass. */
        async pass(stepMs = AIS_WATCH_TICK_MS) {
            t += stepMs;
            await watch.passOnce();
            return watch.describe();
        },
    };
}

// ── The watcher ────────────────────────────────────────────────────────────

test('a crossing ship opens one alarm; held opening 30 s over 3 passes, it closes', async () => {
    const h = harness();
    // Nordlicht 2 NM east of us in the Solent, heading west at 10 kn: head-on.
    let nordlicht = { cogDeg: 270 };
    h.world = (now) =>
        docs(
            now,
            { pos: SOLENT, sogKn: 8, cogDeg: 90 },
            {
                [NORDLICHT]: {
                    at: now - 2_000,
                    pos: offset(SOLENT, 90, 2 - ((now - T0) / 3_600_000) * 18),
                    sogKn: 10,
                    cogDeg: nordlicht.cogDeg,
                    name: 'NORDLICHT',
                },
            },
        );
    h.watch.arm(PREFS);
    const first = await h.pass(0);
    assert.equal(first.state, 'armed');
    assert.equal(first.alarms.length, 1);
    const [a] = first.alarms;
    assert.equal(a.key, `collision:${NORDLICHT}:${T0}`);
    assert.equal(a.kind, 'collision');
    assert.equal(a.mmsi, NORDLICHT);
    assert.equal(a.name, 'NORDLICHT');
    assert.equal(a.ackedAt, null);
    assert.ok(a.cpaNm !== null && a.cpaNm < 0.1);
    assert.ok(a.tcpaMin !== null && a.tcpaMin > 6 && a.tcpaMin < 7);
    assert.deepEqual(h.raised, [a.key]);

    // She turns away (east, as we go): opening from the next pass.
    nordlicht = { cogDeg: 90 };
    for (let i = 0; i < 6; i += 1) {
        const d = await h.pass(); // +5 … +30 s
        assert.equal(d.alarms.length, 1, `still open at pass ${i + 1}`);
    }
    const closed = await h.pass(); // +35 s: 30 s held since the first opening pass, 7 passes
    assert.deepEqual(closed.alarms, []);
    assert.deepEqual(h.raised, [a.key], 'one alarm per vessel per encounter');
});

test('close quarters at anchor with a 6 kn ship sounds; at a berth (no anchor watch) it does not', async () => {
    const world = (now: number) =>
        docs(
            now,
            { pos: HAURAKI, sogKn: 0.2 },
            {
                [BAY_RUNNER]: {
                    at: now - 1_000,
                    pos: offset(HAURAKI, 0, 0.05),
                    sogKn: 6,
                    cogDeg: 180,
                    name: 'BAY RUNNER',
                },
            },
        );
    const anchored = harness({ atAnchor: true });
    anchored.world = world;
    anchored.watch.arm(PREFS);
    const d = await anchored.pass(0);
    assert.equal(d.atAnchor, true);
    assert.equal(d.alarms.length, 1);
    assert.equal(d.alarms[0].kind, 'close-quarters');
    assert.equal(d.alarms[0].key, `close-quarters:${BAY_RUNNER}:${T0}`);

    const berthed = harness({ atAnchor: false });
    berthed.world = world;
    berthed.watch.arm(PREFS);
    const quiet = await berthed.pass(0);
    assert.deepEqual(quiet.alarms, []);
    // At a berth a quiet receiver is not news: stopped there, nothing can sound.
    assert.equal(quiet.state, 'armed');
});

test('distress: a SART heard with no position alarms; a test beacon and a beacon with no status do not', async () => {
    const h = harness();
    h.world = (now) =>
        docs(
            now,
            { pos: CHESAPEAKE, sogKn: 5, cogDeg: 10 },
            {
                [SART]: { at: now - 3_000, state: 'ais-sart' }, // status 14, before its GNSS fix
                [970_000_013]: { at: now - 3_000, pos: offset(CHESAPEAKE, 200, 1), state: 'default' }, // 15: a test
                [MOB]: { at: now - 3_000, pos: offset(CHESAPEAKE, 120, 0.4) }, // no status: a caution
            },
        );
    h.watch.arm(PREFS);
    const d = await h.pass(0);
    assert.equal(d.alarms.length, 1);
    const [sart] = d.alarms;
    assert.equal(sart.kind, 'distress');
    assert.equal(sart.mmsi, SART);
    assert.equal(sart.distressKind, 'sart');
    assert.equal(sart.positionKnown, false);
    assert.equal(sart.lat, null);
    assert.equal(sart.lon, null);
    assert.equal(sart.rangeNm, null);
    assert.equal(sart.key, `distress:${SART}:${T0}`);
    // A beacon is never a collision target, and the cautions stay off the alarm list.
    assert.ok(!d.alarms.some((a) => a.mmsi === MOB || a.mmsi === 970_000_013));
});

test('distress needs no own fix: a beacon is an alarm at any range', async () => {
    const h = harness();
    h.world = (now) => docs(now, null, { [SART]: { at: now - 3_000, pos: offset(SOLENT, 45, 6), state: 'ais-sart' } });
    h.watch.arm(PREFS);
    const d = await h.pass(0);
    assert.equal(d.state, 'no-fix');
    assert.equal(d.alarms.length, 1);
    assert.equal(d.alarms[0].positionKnown, true);
    assert.equal(d.alarms[0].rangeNm, null, 'no fix of our own, so no range');
});

test('ack (kind, mmsi): acknowledged, still open and shown; a new encounter after it closed is a new key', async () => {
    const h = harness();
    let cog = 270;
    let gap = 2;
    h.world = (now) =>
        docs(
            now,
            { pos: SOLENT, sogKn: 8, cogDeg: 90 },
            {
                [NORDLICHT]: {
                    at: now - 2_000,
                    pos: offset(SOLENT, 90, gap),
                    sogKn: 10,
                    cogDeg: cog,
                    name: 'NORDLICHT',
                },
            },
        );
    h.watch.arm(PREFS);
    const open = await h.pass(0);
    const key = open.alarms[0].key;

    // Distress and close quarters are other kinds: acknowledging those does nothing here.
    assert.equal(h.watch.ack('distress', NORDLICHT), null);
    const acked = h.watch.ack('collision', NORDLICHT);
    assert.equal(acked?.key, key);
    assert.equal(acked?.ackedAt, h.now);
    const still = await h.pass();
    assert.equal(still.alarms.length, 1);
    assert.equal(still.alarms[0].key, key);
    assert.equal(still.alarms[0].ackedAt, T0);
    assert.equal(h.watch.cloudExtra().ais_watch_alarms, 0, 'acknowledged: not counted as sounding');

    // She opens and the encounter closes …
    cog = 90;
    for (let i = 0; i < 8; i += 1) await h.pass();
    assert.deepEqual(h.watch.describe().alarms, []);
    // … and her next approach is a new encounter, unacknowledged.
    cog = 270;
    gap = 1.5;
    const again = await h.pass();
    assert.equal(again.alarms.length, 1);
    assert.notEqual(again.alarms[0].key, key);
    assert.equal(again.alarms[0].key, `collision:${NORDLICHT}:${h.now}`);
    // Inside the DANGER mute's 30 min it is raised muted, as on the phone,
    // whose mute is per vessel for 30 min, not per encounter.
    assert.equal(again.alarms[0].ackedAt, T0);
    assert.equal(h.raised.length, 1);
});

test('acknowledging a DANGER never silences close quarters; acknowledging close quarters covers it', async () => {
    const h = harness();
    let gap = 2;
    h.world = (now) =>
        docs(
            now,
            { pos: SOLENT, sogKn: 8, cogDeg: 90 },
            {
                [NORDLICHT]: { at: now - 1_000, pos: offset(SOLENT, 90, gap), sogKn: 10, cogDeg: 270 },
            },
        );
    h.watch.arm(PREFS);
    await h.pass(0);
    h.watch.ack('collision', NORDLICHT);
    // She is now inside 0.1 NM within 3 min: close quarters, a new and unacknowledged alarm.
    gap = 0.4;
    const cq = await h.pass();
    assert.equal(cq.alarms.length, 1);
    assert.equal(cq.alarms[0].kind, 'close-quarters');
    assert.equal(cq.alarms[0].ackedAt, null);
    assert.equal(h.watch.ack('collision', NORDLICHT), null, 'a mute never silences close quarters');
    assert.equal(h.watch.ack('close-quarters', NORDLICHT)?.kind, 'close-quarters');
    assert.notEqual(h.watch.describe().alarms[0].ackedAt, null);
});

test('a DANGER acknowledgement lasts the 30 min a mute does; still alarming after that, it sounds again', async () => {
    const h = harness();
    // Chesapeake Bay: a ship 2 NM ahead, passing 0.3 NM off: DANGER on the offshore pair, held there.
    h.world = (now) =>
        docs(
            now,
            { pos: CHESAPEAKE, sogKn: 6, cogDeg: 0 },
            {
                [NORDLICHT]: { at: now - 1_000, pos: offset(offset(CHESAPEAKE, 0, 2), 90, 0.3), sogKn: 6, cogDeg: 180 },
            },
        );
    h.watch.arm(PREFS);
    const first = await h.pass(0);
    assert.equal(first.alarms[0]?.kind, 'collision');
    h.watch.ack('collision', NORDLICHT);
    await h.pass(rule.COLLISION_RULE.muteMinutes * 60_000 - 5_000);
    assert.notEqual(h.watch.describe().alarms[0]?.ackedAt, null);
    const later = await h.pass(10_000);
    assert.equal(later.alarms[0]?.ackedAt, null);
    assert.equal(h.raised.length, 2, 'sounding again is news');
});

test('blind and no-fix are states, not silence', async () => {
    // Under way, nothing heard: blind on the 60 s line.
    const h = harness();
    h.world = (now) => docs(now, { pos: SOLENT, sogKn: 6, cogDeg: 45 }, {});
    h.watch.arm(PREFS);
    assert.equal((await h.pass(rule.COLLISION_RULE.latch.blindAfterMs - 1_000)).state, 'armed');
    assert.equal((await h.pass(1_000)).state, 'blind');

    // A target heard 50 s ago keeps it watching.
    const heard = harness();
    heard.world = (now) =>
        docs(
            now,
            { pos: SOLENT, sogKn: 6, cogDeg: 45 },
            {
                [NORDLICHT]: { at: now - 50_000, pos: offset(SOLENT, 300, 4), sogKn: 9, cogDeg: 10 },
            },
        );
    heard.watch.arm(PREFS);
    assert.equal((await heard.pass(120_000)).state, 'armed');

    // At anchor the line is 10 min (transponders there report every 3 min).
    const anchored = harness({ atAnchor: true });
    anchored.world = (now) => docs(now, { pos: HAURAKI, sogKn: 0.1 }, {});
    anchored.watch.arm(PREFS);
    assert.equal((await anchored.pass(120_000)).state, 'armed');
    assert.equal((await anchored.pass(rule.COLLISION_RULE.latch.atAnchorBlindAfterMs - 120_000)).state, 'blind');

    // Signal K down is blind, whatever the clock.
    const down = harness();
    down.world = SIGNALK_DOWN;
    down.watch.arm(PREFS);
    assert.equal((await down.pass(0)).state, 'blind');

    // No own fix, a fix over 15 s old, or no own speed: no-fix.
    for (const own of [
        null,
        { pos: SOLENT, sogKn: 6, cogDeg: 45, at: T0 - 16_000 },
        { pos: SOLENT, cogDeg: 45 },
        { pos: SOLENT, sogKn: 6 }, // moving with no course
    ]) {
        const blindOwn = harness();
        blindOwn.world = (now) =>
            docs(now, own, { [NORDLICHT]: { at: now - 2_000, pos: offset(SOLENT, 90, 1), sogKn: 9, cogDeg: 270 } });
        blindOwn.watch.arm(PREFS);
        assert.equal((await blindOwn.pass(0)).state, 'no-fix', JSON.stringify(own));
    }
});

test('a contact lost mid-encounter stays open as lost, until 10 min after her CPA was due', async () => {
    const h = harness();
    let heard = true;
    h.world = (now) =>
        docs(
            now,
            { pos: SOLENT, sogKn: 8, cogDeg: 90 },
            heard ? { [NORDLICHT]: { at: now - 1_000, pos: offset(SOLENT, 90, 2), sogKn: 10, cogDeg: 270 } } : {},
        );
    h.watch.arm(PREFS);
    const open = await h.pass(0);
    const tcpa = open.alarms[0].tcpaMin!;
    heard = false;
    const lost = await h.pass();
    assert.equal(lost.alarms.length, 1);
    assert.equal(lost.alarms[0].lost, 'gone');
    await h.pass(tcpa * 60_000 + rule.COLLISION_RULE.latch.lostHoldAfterCpaMs - 10_000);
    assert.equal(h.watch.describe().alarms.length, 1);
    await h.pass(15_000);
    assert.deepEqual(h.watch.describe().alarms, []);
});

test('our own transponder is never a target, by Signal K’s self or the MMSI the phone sent', async () => {
    const h = harness();
    h.world = (now) => {
        const d = docs(
            now,
            { pos: SOLENT, sogKn: 8, cogDeg: 90 },
            {
                [OWN_MMSI + 1]: { at: now - 1_000, pos: offset(SOLENT, 90, 0.05), sogKn: 8, cogDeg: 270 },
            },
        );
        // Signal K's self under a uuid: only the arm's MMSI says it is us.
        return { ...d, selfAnswer: 'vessels.urn:mrn:signalk:uuid:0000' };
    };
    h.watch.arm(PREFS, { ownMmsi: OWN_MMSI + 1 });
    assert.deepEqual((await h.pass(0)).alarms, []);
});

test('our own boat is never a target when Signal K’s `self` read fails and no phone sent an MMSI', async () => {
    // Kestrel under way in the Solent, filed under her MMSI in `vessels` as Signal K does.
    const kestrelInVessels = (now: number) =>
        shipDoc(OWN_MMSI, { at: now - 1_000, pos: SOLENT, sogKn: 6, cogDeg: 90, name: 'KESTREL' });
    const world = (selfAnswerOk: () => boolean, selfDocHasMmsi: boolean) => (now: number) => {
        const d = docs(now, { pos: SOLENT, sogKn: 6, cogDeg: 90 }, {});
        (d.vesselsDoc as Record<string, unknown>)[SELF_URN] = kestrelInVessels(now);
        if (selfDocHasMmsi) (d.selfDoc as Record<string, unknown>).mmsi = String(OWN_MMSI);
        return { ...d, selfAnswer: selfAnswerOk() ? d.selfAnswer : null };
    };
    // `self` fails on its own: the MMSI vessels/self carries still says it is us.
    const byMmsi = harness();
    byMmsi.world = world(() => false, true);
    byMmsi.watch.arm(PREFS); // no ownMmsi: a skipper who never typed it
    assert.deepEqual((await byMmsi.pass(0)).alarms, []);
    assert.deepEqual((await byMmsi.pass()).alarms, []);
    assert.deepEqual(byMmsi.raised, []);

    // No MMSI anywhere but the URN: `self` answered once, and that is kept for a read that fails.
    let answered = true;
    const byUrn = harness();
    byUrn.world = world(() => answered, false);
    byUrn.watch.arm(PREFS);
    assert.deepEqual((await byUrn.pass(0)).alarms, []);
    answered = false;
    assert.deepEqual((await byUrn.pass()).alarms, []);
    assert.deepEqual(byUrn.raised, []);
});

test('an acknowledgement that reaches the Pi before its own alarm settles the alarm it then raises', async () => {
    // The phone grades every 2 s LAN read; the Pi every 5 s: the phone often raises (and is muted) first.
    const h = harness();
    let gap = 2;
    h.world = (now) =>
        docs(
            now,
            { pos: SOLENT, sogKn: 8, cogDeg: 90 },
            { [NORDLICHT]: { at: now - 1_000, pos: offset(SOLENT, 90, gap), sogKn: 10, cogDeg: 270 } },
        );
    h.watch.arm(PREFS);
    assert.equal(h.watch.ack('collision', NORDLICHT), null, 'nothing open here yet');
    const d = await h.pass(2_000);
    assert.equal(d.alarms.length, 1);
    assert.equal(d.alarms[0].kind, 'collision');
    assert.equal(d.alarms[0].ackedAt, T0, 'settled from the moment the phone muted her');
    assert.deepEqual(h.raised, [], 'raised settled: never news to push');
    assert.equal(h.watch.cloudExtra().ais_watch_alarms, 0);
    // The DANGER mute still never covers close quarters.
    gap = 0.4;
    const cq = await h.pass();
    assert.equal(cq.alarms[0].kind, 'close-quarters');
    assert.equal(cq.alarms[0].ackedAt, null);
    assert.equal(h.raised.length, 1);
});

test('close quarters acknowledged on a phone first: settled here; held only 5 min with no encounter of its own', async () => {
    let away = false;
    const world = (now: number) =>
        docs(
            now,
            { pos: HAURAKI, sogKn: 0.2 },
            {
                [BAY_RUNNER]: away
                    ? { at: now - 1_000, pos: offset(HAURAKI, 0, 0.6), sogKn: 6, cogDeg: 0 }
                    : { at: now - 1_000, pos: offset(HAURAKI, 0, 0.05), sogKn: 6, cogDeg: 180 },
            },
        );
    const early = harness({ atAnchor: true });
    early.world = world;
    early.watch.arm(PREFS);
    early.watch.ack('close-quarters', BAY_RUNNER);
    const settled = await early.pass(rule.COLLISION_RULE.latch.clearAfterMs);
    assert.equal(settled.alarms[0]?.kind, 'close-quarters');
    assert.equal(settled.alarms[0]?.ackedAt, T0);
    assert.deepEqual(early.raised, []);
    // Her encounter ends; her next close quarters, a minute on, is a new one and sounds.
    away = true;
    for (let i = 0; i < 8; i += 1) await early.pass();
    assert.deepEqual(early.watch.describe().alarms, []);
    away = false;
    const next = await early.pass();
    assert.equal(next.alarms[0]?.ackedAt, null);
    assert.equal(early.raised.length, 1);

    // The same acknowledgement 5 min before she closes is about another encounter: it sounds.
    const late = harness({ atAnchor: true });
    late.world = world;
    late.watch.arm(PREFS);
    late.watch.ack('close-quarters', BAY_RUNNER);
    const sounds = await late.pass(5 * 60_000);
    assert.equal(sounds.alarms[0]?.ackedAt, null);
    assert.equal(late.raised.length, 1);
});

test('close quarters acknowledged while the Pi still calls her DANGER: her close quarters later in that encounter is settled', async () => {
    const h = harness();
    let gap = 2;
    h.world = (now) =>
        docs(
            now,
            { pos: SOLENT, sogKn: 8, cogDeg: 90 },
            { [NORDLICHT]: { at: now - 1_000, pos: offset(SOLENT, 90, gap), sogKn: 10, cogDeg: 270 } },
        );
    h.watch.arm(PREFS);
    await h.pass(0);
    assert.equal(h.watch.ack('close-quarters', NORDLICHT)?.kind, 'collision');
    // Minutes later, the same encounter: close quarters here too.
    for (let i = 0; i < 70; i += 1) await h.pass(); // ~6 min, past the 5 min early window
    gap = 0.4;
    const cq = await h.pass();
    assert.equal(cq.alarms[0].kind, 'close-quarters');
    assert.notEqual(cq.alarms[0].ackedAt, null);
    assert.equal(h.raised.length, 1);
});

test('a distress silenced on a phone first is raised silenced here; a new activation after it ended sounds', async () => {
    const h = harness();
    let active = true;
    h.world = (now) =>
        docs(
            now,
            { pos: CHESAPEAKE, sogKn: 5, cogDeg: 10 },
            active ? { [SART]: { at: now - 3_000, pos: offset(CHESAPEAKE, 45, 2), state: 'ais-sart' } } : {},
        );
    h.watch.arm(PREFS);
    assert.equal(h.watch.ack('distress', SART), null);
    const d = await h.pass(0);
    assert.equal(d.alarms[0]?.kind, 'distress');
    assert.equal(d.alarms[0]?.ackedAt, T0);
    assert.deepEqual(h.raised, []);
    active = false;
    assert.deepEqual((await h.pass()).alarms, []);
    active = true;
    const again = await h.pass();
    assert.equal(again.alarms[0]?.ackedAt, null);
    assert.equal(h.raised.length, 1);
});

test('a DANGER muted again runs its 30 min from the newest mute', async () => {
    const h = harness();
    h.world = (now) =>
        docs(
            now,
            { pos: CHESAPEAKE, sogKn: 6, cogDeg: 0 },
            {
                [NORDLICHT]: { at: now - 1_000, pos: offset(offset(CHESAPEAKE, 0, 2), 90, 0.3), sogKn: 6, cogDeg: 180 },
            },
        );
    h.watch.arm(PREFS);
    await h.pass(0);
    h.watch.ack('collision', NORDLICHT);
    await h.pass(10 * 60_000);
    assert.equal(h.watch.ack('collision', NORDLICHT)?.ackedAt, h.now);
    await h.pass(25 * 60_000); // 35 min after the first mute, 25 after the second
    assert.notEqual(h.watch.describe().alarms[0]?.ackedAt, null);
});

test('every device that armed it is kept: one device’s disarm never ends a watch another set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-watch-'));
    try {
        const h = harness({ store: fileAisWatchStore(dir) });
        h.world = (now) => docs(now, { pos: HAURAKI, sogKn: 6, cogDeg: 10 }, {});
        const skipper = { offshore: { cpaNm: 1, tcpaMin: 20 }, inshore: { cpaNm: 0.2, tcpaMin: 6 } };
        const tablet = { offshore: { cpaNm: 0.5, tcpaMin: 30 }, inshore: { cpaNm: 0.3, tcpaMin: 4 } };
        h.watch.arm(skipper, { ownMmsi: OWN_MMSI, device: 'dev-iphone' });
        // The nav-table iPad arms too, with its own thresholds and no MMSI of its own.
        h.watch.arm(tablet, { device: 'dev-ipad' });
        let d = h.watch.describe();
        assert.equal(d.devices, 2);
        assert.equal(d.ownMmsi, OWN_MMSI, 'an arm with no MMSI keeps the one known');
        // The strictest of both: it sounds whenever either device would.
        assert.deepEqual(d.prefs, {
            offshore: { cpaNm: 1, tcpaMin: 30 },
            inshore: { cpaNm: 0.3, tcpaMin: 6 },
        });
        // Someone quietens the iPad: the skipper's watch stands.
        h.watch.disarm({ device: 'dev-ipad' });
        d = h.watch.describe();
        assert.equal(d.state, 'armed');
        assert.equal(d.devices, 1);
        assert.deepEqual(d.prefs, skipper);
        // A crew phone that never armed it changes nothing.
        h.watch.disarm({ device: 'dev-crew' });
        assert.equal(h.watch.describe().armed, true);
        // Kept across a restart, who armed it included.
        const back = new AisNightWatch({
            documents: async () => SIGNALK_DOWN(T0),
            atAnchor: () => false,
            store: fileAisWatchStore(dir),
            setIntervalImpl: (() => 0) as unknown as typeof setInterval,
            clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
        });
        assert.equal(back.restore(), true);
        assert.equal(back.describe().devices, 1);
        back.disarm({ device: 'dev-ipad' });
        assert.equal(back.describe().armed, true);
        back.disarm({ device: 'dev-iphone' });
        assert.equal(back.describe().state, 'off', 'the last device to disarm stands it down');
        back.close();

        // Standing it down for everyone, from any device aboard.
        h.watch.arm(tablet, { device: 'dev-ipad' });
        h.watch.disarm({ device: 'dev-crew', everyone: true });
        assert.equal(h.watch.describe().state, 'off');
        assert.equal(fileAisWatchStore(dir).read(), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('disarmed: no alarms and state off; armed state and thresholds survive a restart; a bad store reads as off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ais-watch-'));
    try {
        const store = fileAisWatchStore(dir);
        const h = harness({ store });
        h.world = (now) =>
            docs(
                now,
                { pos: SOLENT, sogKn: 8, cogDeg: 90 },
                {
                    [NORDLICHT]: { at: now - 1_000, pos: offset(SOLENT, 90, 2), sogKn: 10, cogDeg: 270 },
                },
            );
        const off = await h.pass(0);
        assert.equal(off.state, 'off');
        assert.deepEqual(off.alarms, []);
        assert.deepEqual(h.watch.cloudExtra(), { ais_watch: 'off', ais_watch_at_ms: h.now, ais_watch_alarms: 0 });

        const mine = { offshore: { cpaNm: 1, tcpaMin: 30 }, inshore: { cpaNm: 0.3, tcpaMin: 8 } };
        h.watch.arm(mine, { ownMmsi: OWN_MMSI });
        assert.equal((await h.pass()).alarms.length, 1);

        // A restart: a new process, the same CACHE_DIR.
        const restarted = new AisNightWatch({
            documents: async () => SIGNALK_DOWN(T0),
            atAnchor: () => false,
            now: () => T0 + 60_000,
            store: fileAisWatchStore(dir),
            setIntervalImpl: (() => 0) as unknown as typeof setInterval,
            clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
        });
        assert.equal(restarted.restore(), true);
        const back = restarted.describe();
        assert.equal(back.armed, true);
        assert.deepEqual(back.prefs, mine);
        assert.equal(back.ownMmsi, OWN_MMSI);

        h.watch.disarm();
        const stood = h.watch.describe();
        assert.equal(stood.state, 'off');
        assert.deepEqual(stood.alarms, []);
        assert.deepEqual((await h.pass()).alarms, [], 'no pass runs while disarmed');
        assert.equal(fileAisWatchStore(dir).read(), null, 'disarming clears what is kept');

        // A corrupt or odd store is off, never armed with made-up thresholds.
        const file = path.join(dir, 'ais-watch.json');
        for (const junk of [
            '{nope',
            '[]',
            '{"armed":"yes"}',
            JSON.stringify({ armed: true, prefs: 'x' }),
            JSON.stringify({ armed: true, prefs: PREFS, devices: [{ id: 'not an id', prefs: PREFS }] }),
            JSON.stringify({ armed: true, prefs: PREFS, devices: [] }),
            'x'.repeat(9_000),
        ]) {
            fs.writeFileSync(file, junk);
            const w = new AisNightWatch({
                documents: async () => SIGNALK_DOWN(T0),
                atAnchor: () => false,
                store: fileAisWatchStore(dir),
            });
            assert.equal(w.restore(), false, junk.slice(0, 20));
            assert.equal(w.describe().state, 'off');
            w.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the store is written only on change', () => {
    let saves = 0;
    let clears = 0;
    const store: AisWatchStore = {
        read: () => null,
        save: () => {
            saves += 1;
        },
        clear: () => {
            clears += 1;
        },
    };
    const w = new AisNightWatch({
        documents: async () => SIGNALK_DOWN(T0),
        atAnchor: () => false,
        now: () => T0,
        store,
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    w.arm(PREFS);
    w.arm(PREFS);
    w.arm({ ...PREFS, offshore: { cpaNm: 0.6, tcpaMin: 15 } });
    assert.equal(saves, 2);
    w.disarm();
    w.disarm();
    assert.equal(clears, 1);
    w.close();
});

test('the open alarm list is bounded, most urgent first', async () => {
    const h = harness();
    const ships: Record<number, Ship> = { [SART]: { at: T0 - 1_000, state: 'ais-sart' } };
    // A ring of 30 ships, all closing on us at once (a fictional worst case).
    for (let i = 0; i < 30; i += 1) {
        const bearing = i * 12;
        ships[211_000_100 + i] = {
            at: T0 - 1_000,
            pos: offset(SOLENT, bearing, 0.4 + i * 0.02),
            sogKn: 10,
            cogDeg: (bearing + 180) % 360,
        };
    }
    h.world = (now) => docs(now, { pos: SOLENT, sogKn: 0.6, cogDeg: 0 }, ships);
    h.watch.arm(PREFS);
    const d = await h.pass(0);
    assert.equal(AIS_WATCH_MAX_ALARMS, 20);
    assert.equal(d.alarms.length, 20);
    assert.equal(d.alarms[0].kind, 'distress');
    const kinds = d.alarms.map((a) => a.kind);
    const rank = (k: AisWatchKind) => (k === 'distress' ? 0 : k === 'close-quarters' ? 1 : 2);
    assert.deepEqual(
        kinds,
        [...kinds].sort((a, b) => rank(a) - rank(b)),
    );
});

test('CPU: 300 targets in one pass well inside 50 ms', async () => {
    const ships: Record<number, Ship> = {};
    for (let i = 0; i < 300; i += 1) {
        ships[211_100_000 + i] = {
            at: T0 - 2_000,
            pos: offset(SOLENT, (i * 37) % 360, 0.5 + (i % 40) * 0.25),
            sogKn: 4 + (i % 12),
            cogDeg: (i * 53) % 360,
            state: i % 5 === 0 ? 'moored' : 'motoring',
        };
    }
    const answer = docs(T0, { pos: SOLENT, sogKn: 7, cogDeg: 30 }, ships);
    const w = new AisNightWatch({
        documents: async () => answer,
        atAnchor: () => false,
        now: () => T0,
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    w.arm(PREFS);
    for (let i = 0; i < 3; i += 1) await w.passOnce(); // warm up
    const times: number[] = [];
    for (let i = 0; i < 7; i += 1) {
        const start = process.hrtime.bigint();
        await w.passOnce();
        times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    times.sort((a, b) => a - b);
    const median = times[3];
    assert.equal(w.describe().targets, 300);
    assert.ok(median < 50, `a pass over 300 targets took ${median.toFixed(1)} ms`);
    w.close();
});

// ── One Signal K read for the phone and the watch ──────────────────────────

function countingSignalK(answer: () => SignalkDocuments) {
    const hits: string[] = [];
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    const fetchImpl = async (url: string) => {
        hits.push(url);
        if (url.endsWith('/signalk')) return ok({ endpoints: { v1: { 'signalk-http': 'http://sk/signalk/v1/api/' } } });
        const d = answer();
        if (url.endsWith('/vessels/self')) return ok(d.selfDoc);
        if (url.endsWith('/vessels')) return ok(d.vesselsDoc);
        if (url.endsWith('/self')) return ok(d.selfAnswer);
        return { ok: false, status: 404, json: async () => null, text: async () => '' };
    };
    return { hits, fetchImpl };
}

test('a phone poll and a watch pass within 1.5 s make ONE Signal K read of the vessels', async () => {
    let t = T0;
    const sk = countingSignalK(() =>
        docs(
            t,
            { pos: SOLENT, sogKn: 8, cogDeg: 90 },
            {
                [NORDLICHT]: { at: t - 1_000, pos: offset(SOLENT, 90, 2), sogKn: 10, cogDeg: 270 },
            },
        ),
    );
    const reader = new SharedSignalkReader({ fetchImpl: sk.fetchImpl, signalkOrigin: 'http://sk', now: () => t });
    const watch = new AisNightWatch({
        documents: () => reader.read(),
        atAnchor: () => false,
        now: () => t,
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    watch.arm(PREFS);
    const vesselReads = () => sk.hits.filter((u) => u.endsWith('/vessels')).length;

    const payload = await readLanTelemetry({
        fetchImpl: sk.fetchImpl,
        signalkOrigin: 'http://sk',
        deviceLabel: 'calypso',
        now: () => t,
        documents: () => reader.read(),
        aisWatch: () => watch.describe(),
    });
    t += SIGNALK_SHARED_CACHE_MS - 100;
    await watch.passOnce();
    assert.equal(vesselReads(), 1);
    assert.equal(payload.ais.length, 1);
    assert.equal(watch.describe().alarms.length, 1);

    // Two at the same moment share the one request in flight.
    t += 1_000;
    await Promise.all([reader.read(), reader.read(), watch.passOnce()]);
    assert.equal(vesselReads(), 2);

    // /api/telemetry carries the watch.
    const later = await readLanTelemetry({
        fetchImpl: sk.fetchImpl,
        signalkOrigin: 'http://sk',
        deviceLabel: 'calypso',
        now: () => t,
        documents: () => reader.read(),
        aisWatch: () => watch.describe(),
    });
    assert.equal(later.ais_watch?.state, 'armed');
    assert.equal(later.ais_watch?.alarms[0]?.mmsi, NORDLICHT);
    assert.equal(later.ais_watch?.servedAt, t);
    watch.close();
});

test('the cloud body carries the three ais_watch keys first in extra', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const sk = countingSignalK(() => docs(T0, { pos: SOLENT, sogKn: 8, cogDeg: 90 }, {}));
    const watch = new AisNightWatch({
        documents: async () => docs(T0, { pos: SOLENT, sogKn: 8, cogDeg: 90 }, {}),
        atAnchor: () => false,
        now: () => T0,
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    watch.arm(PREFS);
    await watch.passOnce();
    const publisher = new TelemetryPublisher({
        fetchImpl: async (url, init) => {
            if (String(url).includes('telemetry-relay')) {
                posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
                return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
            }
            return sk.fetchImpl(String(url));
        },
        signalkOrigin: 'http://sk',
        endpoint: 'https://fictional.supabase.co/functions/v1/telemetry-relay',
        anonKey: () => 'anon',
        credentials: () => ({ relayId: 'relay-1234567890abcdef', token: 'a'.repeat(64) }),
        internetAllowed: () => true,
        deviceLabel: 'calypso',
        now: () => T0,
        aisWatchExtra: () => watch.cloudExtra(),
    });
    assert.equal(await publisher.publishOnce(), 'sent');
    const extra = posted[0].extra as Record<string, unknown>;
    assert.deepEqual(Object.keys(extra).slice(0, 3), ['ais_watch', 'ais_watch_at_ms', 'ais_watch_alarms']);
    assert.equal(extra.ais_watch, 'armed');
    assert.equal(extra.ais_watch_at_ms, T0);
    watch.close();
});

// ── The LAN surface ────────────────────────────────────────────────────────

function routes(watch: AisNightWatch) {
    const app = express();
    app.use(express.json());
    app.use('/api/ais-watch', createAisWatchRoutes(watch));
    // express.json's own 400 for a body that is not JSON, without its stack on stderr.
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.status ?? 500).json({ status: 'error' });
    });
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/ais-watch`;
    const call = async (sub: string, method: string, body?: unknown) => {
        const res = await fetch(`${base}${sub}`, {
            method,
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let parsed: Record<string, unknown> = {};
        try {
            parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
            /* express's own 400 page for a body that is not JSON */
        }
        return { status: res.status, body: parsed };
    };
    return { call, close: () => server.close() };
}

test('POST /api/ais-watch arms through sanitiseCollisionPrefs, disarms, and refuses what is not a watch', async () => {
    const watch = new AisNightWatch({
        documents: async () => SIGNALK_DOWN(T0),
        atAnchor: () => false,
        now: () => T0,
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    const r = routes(watch);
    try {
        const armed = await r.call('', 'POST', {
            armed: true,
            prefs: { offshore: { cpaNm: 99, tcpaMin: 'x' }, inshore: { cpaNm: 0.01 } },
            ownMmsi: OWN_MMSI,
        });
        assert.equal(armed.status, 200);
        assert.deepEqual(watch.describe().prefs, {
            offshore: { cpaNm: 3, tcpaMin: 15 },
            inshore: { cpaNm: 0.05, tcpaMin: 6 },
        });
        assert.equal((armed.body.watch as Record<string, unknown>).armed, true);
        assert.equal(watch.describe().ownMmsi, OWN_MMSI);

        assert.equal((await r.call('', 'GET')).body.armed, true);
        for (const bad of [{}, { armed: 'yes' }, { armed: true, ownMmsi: 12 }, 'nope']) {
            assert.equal((await r.call('', 'POST', bad)).status, 400, JSON.stringify(bad));
        }
        assert.equal(watch.describe().armed, true, 'a refused request changes nothing');

        for (const bad of [
            { armed: true, device: 'a b' },
            { armed: false, device: 7 },
            { armed: false, everyone: 'yes' },
        ]) {
            assert.equal((await r.call('', 'POST', bad)).status, 400, JSON.stringify(bad));
        }
        // A second device arms it; its disarm leaves the first one's watch on.
        assert.equal((await r.call('', 'POST', { armed: true, prefs: PREFS, device: 'dev-ipad' })).status, 200);
        assert.equal(watch.describe().devices, 2);
        assert.equal(watch.describe().ownMmsi, OWN_MMSI);
        const one = await r.call('', 'POST', { armed: false, device: 'dev-ipad' });
        assert.equal((one.body.watch as Record<string, unknown>).armed, true);

        const off = await r.call('', 'POST', { armed: false });
        assert.equal(off.status, 200);
        assert.equal(watch.describe().state, 'off');
        // Stood down for everyone, whoever armed it.
        await r.call('', 'POST', { armed: true, prefs: PREFS, device: 'dev-iphone' });
        await r.call('', 'POST', { armed: true, prefs: PREFS, device: 'dev-ipad' });
        assert.equal((await r.call('', 'POST', { armed: false, device: 'dev-crew', everyone: true })).status, 200);
        assert.equal(watch.describe().state, 'off');
    } finally {
        r.close();
        watch.close();
    }
});

test('POST /api/ais-watch/ack takes (kind, mmsi), and nothing else', async () => {
    let t = T0;
    const watch = new AisNightWatch({
        documents: async () =>
            docs(
                t,
                { pos: SOLENT, sogKn: 8, cogDeg: 90 },
                {
                    [NORDLICHT]: { at: t - 1_000, pos: offset(SOLENT, 90, 2), sogKn: 10, cogDeg: 270 },
                },
            ),
        atAnchor: () => false,
        now: () => t,
        setIntervalImpl: (() => 0) as unknown as typeof setInterval,
        clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
    });
    watch.arm(PREFS);
    await watch.passOnce();
    const r = routes(watch);
    try {
        const ok = await r.call('/ack', 'POST', { kind: 'collision', mmsi: NORDLICHT });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.acked, true);
        t += 1_000;
        assert.equal(watch.describe().alarms[0].ackedAt, T0);
        const none = await r.call('/ack', 'POST', { kind: 'distress', mmsi: NORDLICHT });
        assert.equal(none.status, 200);
        assert.equal(none.body.acked, false);
        for (const bad of [
            { kind: 'all', mmsi: NORDLICHT },
            { kind: 'collision', mmsi: 'x' },
            { kind: 'collision', mmsi: 12 },
        ]) {
            assert.equal((await r.call('/ack', 'POST', bad)).status, 400, JSON.stringify(bad));
        }
    } finally {
        r.close();
        watch.close();
    }
});

test('server.ts: the watch is on the app gate, in the admin status, restored at boot and closed at shutdown', () => {
    const source = fs.readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    // 126-04b: the test push rides the same router, on the same gate.
    assert.ok(
        source.includes(
            "app.use('/api/ais-watch', requireAppApi, createAisWatchRoutes(aisWatch, { test: () => piAlarmRelay.test() }))",
        ),
    );
    assert.ok(source.includes('aisWatch: aisWatch.describe()'));
    assert.ok(source.includes('aisWatch.restore()'));
    assert.ok(source.includes('aisWatch.close()'));
    // The Pi's own anchor runner is what 'at anchor' means here.
    assert.ok(source.includes('atAnchor: () => anchorWatch.isRunning()'));
    // One Signal K read serves /api/telemetry and the watch.
    assert.match(
        source,
        /documents: \(\) => signalkDocuments\.read\(\)[\s\S]*documents: \(\) => signalkDocuments\.read\(\)/,
    );
    assert.ok(source.includes('aisWatchExtra: () => aisWatch.cloudExtra()'));
});
