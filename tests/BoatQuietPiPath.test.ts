// @vitest-environment node
/**
 * The quiet-boat watchdog's facts, end to end (129-08): what the Pi really
 * posts (the real TelemetryPublisher with the real onboard supplement the Pi
 * runs, pi-cache/src/server.ts), what the relay really keeps (its own
 * parseTelemetryBody, the row stamped updated_at on receipt as
 * telemetry-relay/index.ts does), and what the watchdog makes of that row
 * (tests/helpers/boatQuietModel.ts, the held SQL's mirror).
 *
 * The states: her whole bus silent with her GPS clock stalled, with and
 * without an onboard barometer; her GPS dead while her depth still talks;
 * Signal K itself down; and her Pi switched off. A Pi that is up and online
 * keeps being heard, so "her Pi is offline" is said only when nothing comes,
 * "her instruments are silent" only when the bus is, and nothing old is
 * dated as new. Fictional boat 'Kestrel' in Oslofjord.
 */
import { describe, expect, it } from 'vitest';
import { createOnboardSupplement } from '../pi-cache/src/onboardSensors';
import { TelemetryPublisher } from '../pi-cache/src/telemetryPublisher';
import { parseTelemetryBody, type TelemetryRow } from '../supabase/functions/telemetry-relay/parse';
import { runOnce, type Telemetry, type WatchRow, type World } from './helpers/boatQuietModel';

const MIN = 60_000;
const T0 = Date.parse('2026-10-14T03:00:00Z');
const OWNER = '00000000-0000-4000-8000-0000000000f0';

/** Signal K's self document: the GPS (clock, position, SOG) as of gpsAt, the depth as of depthAt. */
function selfDoc(gpsAt: number, depthAt: number) {
    const gps = new Date(gpsAt).toISOString();
    const depth = new Date(depthAt).toISOString();
    return {
        navigation: {
            datetime: { value: gps, timestamp: gps },
            position: { value: { latitude: 59.91, longitude: 10.75 }, timestamp: gps },
            speedOverGround: { value: 0.1, timestamp: gps },
        },
        environment: { depth: { belowTransducer: { value: 6.3, timestamp: depth } } },
    };
}

/** The boat: her Pi (up or not), Signal K's document, an optional barometer; the relay's last row. */
function boat(options: { barometer?: boolean } = {}) {
    const state = {
        now: T0,
        piUp: true,
        doc: selfDoc(T0, T0) as unknown,
        row: null as (TelemetryRow & { updated_at: number }) | null,
        refused: [] as string[],
    };
    const signalK = (url: string) => {
        if (state.doc === null) return Promise.reject(new Error('Signal K is down'));
        if (url.endsWith('/signalk')) {
            return Promise.resolve(
                new Response(JSON.stringify({ endpoints: { v1: { 'signalk-http': 'http://sk/signalk/v1/api/' } } })),
            );
        }
        return Promise.resolve(new Response(JSON.stringify(state.doc)));
    };
    const publisher = new TelemetryPublisher({
        signalkOrigin: 'http://sk',
        endpoint: 'https://example.supabase.co/functions/v1/telemetry-relay',
        anonKey: () => 'anon',
        credentials: () => ({ relayId: 'relay-1234567890abcdef', token: 'a'.repeat(64) }),
        internetAllowed: () => true,
        deviceLabel: 'kestrel-pi',
        now: () => state.now,
        supplement: createOnboardSupplement({
            barometer: () => {
                const latest = options.barometer ? { at: state.now - 30_000, hpa: 1011.8, tempC: 17.2 } : null;
                return {
                    available: !!latest,
                    reason: latest ? null : 'no sensor fitted',
                    latest,
                    samples: latest ? [latest] : [],
                };
            },
            now: () => state.now,
        }),
        fetchImpl: async (url, init) => {
            if (!String(url).includes('telemetry-relay')) return signalK(String(url));
            // The relay: parse with its own fence, then one row per skipper, stamped on receipt.
            const parsed = parseTelemetryBody(JSON.parse(String(init?.body)) as Record<string, unknown>, state.now);
            if (!parsed.ok) {
                state.refused.push(parsed.error);
                return new Response(JSON.stringify({ error: parsed.error }), { status: 400 });
            }
            state.row = { ...parsed.row, updated_at: state.now };
            return new Response('{"ok":true}');
        },
    });
    /** One minute of the Pi's five-second publishing, as the clock runs. */
    const minute = async () => {
        for (let s = 0; s < 60; s += 5) {
            state.now += 5_000;
            if (state.piUp) await publisher.publishOnce();
        }
    };
    const telemetry = (): Telemetry | null =>
        state.row && {
            updatedAt: state.row.updated_at,
            reportedAt: Date.parse(state.row.reported_at),
            busAtMs: typeof state.row.extra.bus_at_ms === 'number' ? state.row.extra.bus_at_ms : null,
        };
    return { state, minute, telemetry };
}

const watch: WatchRow = {
    ownerId: OWNER,
    enabled: true,
    armedAt: Date.parse('2026-10-01T00:00:00Z'),
    pagedAt: null,
    pagedLastHeardAt: null,
    pagedBusAt: null,
    pagedKind: null,
    pagedRecipients: null,
    clearedAt: null,
    quietAfterMinutes: 15,
    window: null,
};
const world: World = { crew: [], optouts: new Set(), deleting: new Set(), boatName: 'Kestrel' };

/** The watchdog every minute for `minutes`; the first page or all-clear it sends. */
async function watchFor(b: ReturnType<typeof boat>, minutes: number) {
    let row = watch;
    for (let m = 0; m < minutes; m++) {
        await b.minute();
        const run = runOnce(b.state.now, row, b.telemetry(), world);
        row = run.row;
        if (run.pushes.length) return { at: (b.state.now - T0) / MIN, ...run };
    }
    return null;
}

describe('what the watchdog hears from a real Pi through the real relay', () => {
    it('her whole bus silent, her GPS clock stalled with it: the Pi is still heard, and the page says instruments', async () => {
        const b = boat();
        b.state.doc = selfDoc(T0, T0); // Signal K keeps the dead bus's last values and times
        const page = await watchFor(b, 60);
        expect(page).toMatchObject({ verdict: 'page_instruments_silent' });
        expect(page!.at).toBeGreaterThanOrEqual(15);
        expect(page!.at).toBeLessThanOrEqual(16);
        expect(page!.pushes[0]).toMatchObject({
            title: 'Kestrel’s instruments are silent',
            body: 'Her Pi is still reporting, but nothing from her GPS or instruments for 15 minutes. Thalassa will tell you when she reports again.',
        });
        // The row: heard just now, its readings still dated when they were taken.
        expect(b.state.row!.updated_at).toBe(b.state.now);
        expect(b.state.row!.reported_at).toBe(new Date(T0).toISOString());
        expect(b.state.row!.lat).toBe(59.91);
        expect(b.state.refused).toEqual([]);
    });

    it('the same beside a fresh barometer: the barometer’s row says when the bus last spoke', async () => {
        const b = boat({ barometer: true });
        const page = await watchFor(b, 60);
        expect(page).toMatchObject({ verdict: 'page_instruments_silent' });
        expect(b.state.row!.pressure_hpa).toBe(1011.8);
        expect(b.state.row!.lat).toBeNull();
        expect(b.state.row!.extra.bus_at_ms).toBe(T0);
    });

    it('her GPS dead but her depth still talking: never a page, and the relay keeps hearing her', async () => {
        const b = boat();
        for (let m = 0; m < 60; m++) {
            b.state.doc = selfDoc(T0, b.state.now + 5_000);
            await b.minute();
            expect(runOnce(b.state.now, watch, b.telemetry(), world).pushes).toEqual([]);
        }
        expect(b.state.row!.updated_at).toBe(b.state.now);
        expect(b.state.refused).toEqual([]);
    });

    it('Signal K itself down: the bus as last read goes on, so the page is instruments, not the Pi', async () => {
        const b = boat();
        await b.minute();
        b.state.doc = null;
        const page = await watchFor(b, 60);
        expect(page).toMatchObject({ verdict: 'page_instruments_silent' });
    });

    it('her Pi switched off: nothing comes, and the page says her Pi or her internet', async () => {
        const b = boat();
        b.state.doc = selfDoc(T0 + 3 * MIN, T0 + 3 * MIN);
        await b.minute();
        await b.minute();
        await b.minute();
        b.state.piUp = false;
        const page = await watchFor(b, 60);
        expect(page).toMatchObject({ verdict: 'page_pi_offline' });
        expect(page!.pushes[0].title).toBe('Kestrel’s Pi is offline, or the boat’s internet is down');
    });

    it('a relay from before 129-08 refuses the stalled readings after 15 min: why it is deployed before the release', () => {
        const stalled = new Date(T0).toISOString();
        const now = T0 + 16 * MIN;
        expect(parseTelemetryBody({ reported_at: stalled }, now)).toEqual({
            ok: false,
            error: 'reported_at is too old to be live',
        });
        expect(parseTelemetryBody({ reported_at: stalled, sent_at: new Date(now).toISOString() }, now).ok).toBe(true);
    });
});
