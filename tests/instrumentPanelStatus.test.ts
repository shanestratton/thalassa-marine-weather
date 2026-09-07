/**
 * A blank instrument panel must always say which kind of blank it is.
 *
 * On 2026-08-09 the YDWG-02 was connected, the GPS was working, and the panel
 * showed nothing — because the store feeding it had never been started, so a
 * healthy gateway streamed into a UI that believed there was no feed. That bug
 * is fixed. These tests exist so the next one cannot hide behind the same
 * blankness: five distinct causes, five distinct sentences.
 */
import { describe, expect, it } from 'vitest';
import { diagnosePanel, missingInstruments, type PanelMetric } from '../utils/instrumentPanelStatus';

const live = (value = 1): PanelMetric => ({ value, freshness: 'live' });
const stale = (value = 1): PanelMetric => ({ value, freshness: 'stale' });
const dead = (): PanelMetric => ({ value: 1, freshness: 'dead' });
const absent = (): PanelMetric => ({ value: null, freshness: 'dead' });

const diagnose = (over: Partial<Parameters<typeof diagnosePanel>[0]> = {}) =>
    diagnosePanel({ gatewayConfigured: true, connectionStatus: 'connected', metrics: [live()], ...over });

describe('every kind of blank names itself', () => {
    it('distinguishes never-configured from not-connected', () => {
        const never = diagnose({ gatewayConfigured: false, connectionStatus: 'disconnected', metrics: [] });
        const notConnected = diagnose({ connectionStatus: 'disconnected', metrics: [] });

        expect(never.state).toBe('no-gateway');
        expect(notConnected.state).toBe('disconnected');
        // The two must not read the same — that ambiguity is the whole bug.
        expect(never.detail).not.toBe(notConnected.detail);
        expect(never.detail).toMatch(/NMEA Gateway page/);
        expect(notConnected.detail).toMatch(/tap Connect/i);
    });

    it('says connected-but-silent rather than showing an empty panel', () => {
        const d = diagnose({ metrics: [absent(), absent()], secondsSinceConnect: 2 });
        expect(d.state).toBe('waiting');
        expect(d.detail).toMatch(/Waiting for the first sentences/);
        // Two seconds in, this is normal. Don't cry wolf.
        expect(d.actionable).toBe(false);
    });

    it('escalates once "give it a second" stops being true', () => {
        const d = diagnose({ metrics: [absent()], secondsSinceConnect: 40 });
        expect(d.label).toBe('No data');
        expect(d.actionable).toBe(true);
        expect(d.detail).toMatch(/backbone is powered/);
    });

    it('reports a connection error as the gateway refusing, not as no data', () => {
        const d = diagnose({ connectionStatus: 'error', metrics: [] });
        expect(d.state).toBe('error');
        expect(d.detail).toMatch(/refused/);
    });

    it('calls an open socket with frozen readings stale, not live', () => {
        const d = diagnose({ metrics: [stale(), stale()] });
        expect(d.state).toBe('stale');
        expect(d.detail).toMatch(/stopped updating/);
    });

    it('says nothing at all when the panel is genuinely live', () => {
        const d = diagnose({ metrics: [live(), stale()] });
        expect(d.state).toBe('live');
        expect(d.detail).toBeNull();
        expect(d.actionable).toBe(false);
    });

    it('treats a dead metric as absent, never as a reading', () => {
        // A dead metric still holds its last value. It must not count as
        // evidence that data is arriving.
        const d = diagnose({ metrics: [dead(), dead()], secondsSinceConnect: 60 });
        expect(d.state).toBe('waiting');
    });

    it('does not claim "no data" while still connecting', () => {
        const d = diagnose({ connectionStatus: 'connecting', metrics: [] });
        expect(d.state).toBe('connecting');
        expect(d.actionable).toBe(false);
    });
});

describe('missingInstruments', () => {
    it('names the transducer that is quiet while the rest of the boat reports', () => {
        expect(
            missingInstruments([
                { name: 'Wind', metrics: [absent(), absent()] },
                { name: 'Depth', metrics: [live()] },
                { name: 'GPS', metrics: [live(), live()] },
            ]),
        ).toEqual(['Wind']);
    });

    it('stays silent when nothing at all is arriving — the panel message covers that', () => {
        // Listing every instrument when the whole feed is down is noise, and
        // noise is how a useful warning gets ignored.
        expect(
            missingInstruments([
                { name: 'Wind', metrics: [absent()] },
                { name: 'Depth', metrics: [absent()] },
            ]),
        ).toEqual([]);
    });

    it('counts a group as present if any one of its metrics reports', () => {
        // A gateway sending MWV,R but no MWD still has wind.
        expect(missingInstruments([{ name: 'Wind', metrics: [absent(), live()] }])).toEqual([]);
    });

    it('counts a stale group as present — it is reporting, just slowly', () => {
        expect(
            missingInstruments([
                { name: 'Wind', metrics: [stale()] },
                { name: 'Depth', metrics: [live()] },
            ]),
        ).toEqual([]);
    });
});

describe('the Pi over the boat LAN is live, not remote', () => {
    it('names the Pi and the boat network, with the age, and never the hostname', () => {
        const d = diagnose({
            gatewayConfigured: false,
            connectionStatus: 'remote',
            remote: { source: 'pi', deviceLabel: 'calypso', via: 'lan', ageSeconds: 2.2 },
        });
        expect(d.state).toBe('live');
        expect(d.label).toBe('Live · Pi');
        expect(d.detail).toContain('boat network');
        expect(d.detail).toContain('2 s ago');
        expect(d.detail).not.toContain('calypso');
    });

    it('the cloud row stays Remote', () => {
        const d = diagnose({
            gatewayConfigured: false,
            connectionStatus: 'remote',
            remote: { source: 'pi', deviceLabel: 'calypso', via: 'cloud', ageSeconds: 7 },
        });
        expect(d.state).toBe('remote');
        expect(d.label).toBe('Remote');
        expect(d.detail).toContain('through the cloud');
    });
});

describe('crew without a gateway of their own (the panel is invite-only, Shane 2026-09-07)', () => {
    it('not shared: says so, and names where the skipper switches it on', () => {
        const d = diagnose({
            gatewayConfigured: false,
            connectionStatus: 'disconnected',
            metrics: [],
            crewShare: 'not-shared',
        });
        expect(d.state).toBe('no-gateway');
        expect(d.label).toBe('Not shared');
        expect(d.detail).toMatch(/skipper/);
        expect(d.detail).toMatch(/Crew/);
        expect(d.actionable).toBe(false);
    });

    it('shared but nothing arriving: the boat is quiet, not a missing gateway', () => {
        const d = diagnose({
            gatewayConfigured: false,
            connectionStatus: 'disconnected',
            metrics: [],
            crewShare: 'shared',
        });
        expect(d.label).toBe('Boat quiet');
        expect(d.detail).toMatch(/not reporting/);
        expect(d.detail).not.toMatch(/NMEA Gateway page/);
    });

    it('a skipper with no gateway still gets the gateway sentence', () => {
        const d = diagnose({
            gatewayConfigured: false,
            connectionStatus: 'disconnected',
            metrics: [],
            crewShare: 'none',
        });
        expect(d.label).toBe('No gateway');
        expect(d.detail).toMatch(/NMEA Gateway page/);
    });
});
