/**
 * Which gateway to talk to: the Pi, or the YDWG direct.
 *
 * Shane 2026-08-29: "yes most definitely auto swap to direct for 3 people if
 * the pi dies."
 *
 * Once the Pi is aboard it takes one of the YDWG-02's three TCP slots and
 * re-serves the bus to everyone — which is how a crew of four all get
 * instruments. That makes the Pi a single point of failure for something that
 * previously worked for three people without it, so if the Pi stops answering
 * every device falls back to the gateway directly and three of them get in:
 * the same three who would have had data before the Pi existed.
 *
 * The rules are deliberately asymmetric, for the same reason the sail plan's
 * are. A source that flaps is worse than either source alone — it re-opens
 * sockets, burns gateway slots, and shows a connection that never settles.
 * This app has been bitten by that twice this week already.
 */
import { describe, expect, it } from 'vitest';
import { FAILURES_BEFORE_FALLBACK, GatewaySourceSelector, PI_PROBE_INTERVAL_MS } from '../services/nmea/gatewaySource';

const PI = { host: '192.168.1.160', port: 10110 };
const DIRECT = { host: '192.168.1.151', port: 1456 };
const T0 = 1_800_000_000_000;

const failTimes = (s: GatewaySourceSelector, n: number, at = T0) => {
    let switched = false;
    for (let i = 0; i < n; i++) switched = s.onFailedCycle(at + i) || switched;
    return switched;
};

describe('with a Pi configured', () => {
    it('prefers the Pi', () => {
        const s = new GatewaySourceSelector(PI, DIRECT);
        expect(s.current().kind).toBe('pi');
        expect(s.current().endpoint).toEqual(PI);
    });

    it('does not abandon it for one hiccup', () => {
        // A Wi-Fi roam or a Signal K restart is not a dead Pi, and falling
        // back costs a gateway slot somebody else may be using.
        const s = new GatewaySourceSelector(PI, DIRECT);
        expect(failTimes(s, FAILURES_BEFORE_FALLBACK - 1)).toBe(false);
        expect(s.current().kind).toBe('pi');
    });

    it('falls back once the Pi has genuinely stopped answering', () => {
        const s = new GatewaySourceSelector(PI, DIRECT);
        expect(failTimes(s, FAILURES_BEFORE_FALLBACK)).toBe(true);
        expect(s.current().kind).toBe('direct');
        expect(s.current().endpoint).toEqual(DIRECT);
    });

    it('reports the switch exactly once, not on every failure after it', () => {
        const s = new GatewaySourceSelector(PI, DIRECT);
        failTimes(s, FAILURES_BEFORE_FALLBACK);
        expect(s.onFailedCycle(T0 + 100)).toBe(false);
    });

    it('a good cycle resets the count — failures must be CONSECUTIVE', () => {
        const s = new GatewaySourceSelector(PI, DIRECT);
        failTimes(s, FAILURES_BEFORE_FALLBACK - 1);
        s.onFed(T0 + 10);
        expect(failTimes(s, FAILURES_BEFORE_FALLBACK - 1, T0 + 20)).toBe(false);
        expect(s.current().kind).toBe('pi');
    });
});

describe('coming back to the Pi', () => {
    const fallenBack = () => {
        const s = new GatewaySourceSelector(PI, DIRECT);
        failTimes(s, FAILURES_BEFORE_FALLBACK);
        return s;
    };

    it('does not probe immediately after switching', () => {
        const s = fallenBack();
        expect(s.shouldProbePi(T0 + 1_000)).toBe(false);
    });

    it('probes on a slow cadence', () => {
        const s = fallenBack();
        // Comfortably past the deadline: failTimes advances the clock as it
        // goes, so the switch — and with it lastProbeAt — lands a few ms after
        // T0.
        expect(s.shouldProbePi(T0 + PI_PROBE_INTERVAL_MS + 1_000)).toBe(true);
    });

    it('only switches back when the Pi actually DELIVERED data', () => {
        // A completed handshake is not a feed — the lesson of 2026-08-28,
        // where an accepted-then-reset socket read as healthy and strobed the
        // panel for a day.
        const s = fallenBack();
        expect(s.onProbeResult(T0 + PI_PROBE_INTERVAL_MS + 1_000, false)).toBe(false);
        expect(s.current().kind).toBe('direct');
        expect(s.onProbeResult(T0 + 2 * PI_PROBE_INTERVAL_MS, true)).toBe(true);
        expect(s.current().kind).toBe('pi');
    });

    it('a refused probe resets the clock rather than retrying in a loop', () => {
        const s = fallenBack();
        const at = T0 + PI_PROBE_INTERVAL_MS + 1_000;
        s.onProbeResult(at, false);
        expect(s.shouldProbePi(at + 1_000)).toBe(false);
    });

    it('never probes while already on the Pi', () => {
        const s = new GatewaySourceSelector(PI, DIRECT);
        expect(s.shouldProbePi(T0 + 10 * PI_PROBE_INTERVAL_MS)).toBe(false);
    });
});

describe('with no Pi — today s behaviour, unchanged', () => {
    it('uses the gateway and never switches or probes', () => {
        const s = new GatewaySourceSelector(null, DIRECT);
        expect(s.current().kind).toBe('direct');
        expect(failTimes(s, 10)).toBe(false);
        expect(s.shouldProbePi(T0 + 10 * PI_PROBE_INTERVAL_MS)).toBe(false);
        expect(s.current().endpoint).toEqual(DIRECT);
    });

    it('does not offer the skipper a distinction that does not exist', () => {
        expect(new GatewaySourceSelector(null, DIRECT).describe()).toBe('Gateway');
    });
});

describe('what the skipper is told', () => {
    it('names the source, and says when it is the fallback', () => {
        const s = new GatewaySourceSelector(PI, DIRECT);
        expect(s.describe()).toBe('Boat Pi');
        failTimes(s, FAILURES_BEFORE_FALLBACK);
        expect(s.describe()).toBe('Gateway (Pi unavailable)');
    });

    it('does not claim a source is proven until it has fed', () => {
        const s = new GatewaySourceSelector(PI, DIRECT);
        expect(s.current().proven).toBe(false);
        s.onFed(T0);
        expect(s.current().proven).toBe(true);
    });
});
