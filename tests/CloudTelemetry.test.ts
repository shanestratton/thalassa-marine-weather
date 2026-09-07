/**
 * The boat through the cloud — Shane 2026-09-06: "a: vpn, b: supabase, c:
 * dont know". The gateway socket wins; the cloud row feeds the same store when
 * it is not connected; nothing pretends when there is nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listener = vi.hoisted(() => ({ status: 'disconnected' as string }));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: {
        getStatus: () => listener.status,
        onSample: vi.fn(() => vi.fn()),
        onStatusChange: vi.fn(() => vi.fn()),
        getSavedConfig: () => null,
    },
    NMEA_LIVE_MAX_AGE_MS: 6_500,
    NMEA_USABLE_MAX_AGE_MS: 13_000,
}));
vi.mock('../services/NmeaGpsProvider', () => ({ NmeaGpsProvider: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisStore', () => ({ AisStore: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../services/AisHubService', () => ({ AisHubService: { init: vi.fn(), destroy: vi.fn() } }));

import { NmeaStore, type RemoteInstrumentSnapshot } from '../services/NmeaStore';
import { pickRow, rowToTelemetry } from '../services/CloudTelemetryService';
import { diagnosePanel } from '../utils/instrumentPanelStatus';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const snapshot: RemoteInstrumentSnapshot = {
    source: 'pi',
    deviceLabel: 'calypso',
    reportedAt: Date.now() - 4_000,
    lat: -27.2,
    lon: 153.11,
    sogKts: 6.1,
    cogDeg: 44,
    headingDeg: 41,
    stwKts: 5.8,
    twsKts: 14,
    twaDeg: -48,
    twdDeg: 350,
    awsKts: 17,
    awaDeg: -33,
    depthM: 12.4,
    heelDeg: -9,
    pitchDeg: 1,
    waterTempC: 22.5,
    rudderDeg: 2,
    rpm: null,
    voltageV: 13.1,
};

describe('the store takes the cloud when no gateway is connected', () => {
    beforeEach(() => {
        listener.status = 'disconnected';
        NmeaStore.clearRemote();
    });

    it('marks itself remote and carries the whole bus, with the wind angle both ways', () => {
        expect(NmeaStore.ingestRemote(snapshot)).toBe(true);
        const s = NmeaStore.getState();
        expect(s.connectionStatus).toBe('remote');
        expect(s.remote?.deviceLabel).toBe('calypso');
        expect(s.sog.value).toBe(6.1);
        expect(s.twaSigned.value).toBe(-48);
        expect(s.twa.value).toBe(48);
        expect(s.depth.value).toBe(12.4);
        expect(s.voltage.value).toBe(13.1);
        expect(s.rpm.value).toBeNull();
        expect(s.latitude.value).toBe(-27.2);
    });

    it('the boat itself wins: a connected socket refuses the cloud, and the cloud never claims a GPS fix', () => {
        listener.status = 'connected';
        expect(NmeaStore.ingestRemote(snapshot)).toBe(false);
        listener.status = 'disconnected';
        NmeaStore.ingestRemote(snapshot);
        expect(NmeaStore.hasGpsFix()).toBe(false);
    });

    it('clearing goes back to whatever the socket says and empties the gauges', () => {
        NmeaStore.ingestRemote(snapshot);
        NmeaStore.clearRemote();
        const s = NmeaStore.getState();
        expect(s.connectionStatus).toBe('disconnected');
        expect(s.remote).toBeNull();
        expect(s.sog.value).toBeNull();
    });
});

describe('reading the cloud row', () => {
    it('maps the row and prefers the account’s own boat over one it crews on', () => {
        const mine = { owner_id: 'me', reported_at: '2026-09-06T06:00:00Z', source: 'pi', sog_kts: 5, twa_deg: -40 };
        const theirs = { owner_id: 'them', reported_at: '2026-09-06T06:00:30Z', source: 'pi', sog_kts: 8 };
        expect(pickRow([theirs, mine], 'me')?.owner_id).toBe('me');
        expect(pickRow([theirs, mine], 'crew-only')?.owner_id).toBe('them'); // freshest
        const t = rowToTelemetry(mine, 1);
        expect(t?.snapshot.twaDeg).toBe(-40);
        expect(t?.source).toBe('pi');
        expect(rowToTelemetry({ owner_id: 'me', reported_at: 'garbage' }, 1)).toBeNull();
    });
});

describe('the panel says Remote, not Live and not No gateway', () => {
    it('diagnoses a remote feed with its age and source', () => {
        const d = diagnosePanel({
            gatewayConfigured: false,
            connectionStatus: 'remote',
            metrics: [{ value: 6, freshness: 'live' }],
            remote: { source: 'pi', deviceLabel: 'calypso', ageSeconds: 7.4 },
        });
        expect(d.state).toBe('remote');
        expect(d.label).toBe('Remote');
        // The hostname stays out of the punter's eye (Shane 2026-09-07).
        expect(d.detail).toContain('the Pi reported 7 s ago');
        expect(d.detail).not.toContain('calypso');
        expect(d.actionable).toBe(false);
    });

    it('the page gates on remote too, retains the feed while open, and the card yields to a publishing Pi', () => {
        const page = read('components/nmea/TheGlassPage.tsx');
        expect(page).toContain("state.connectionStatus === 'connected' || state.connectionStatus === 'remote'");
        expect(page).toContain('CloudTelemetryService.retain();');
        expect(page).toContain('return () => CloudTelemetryService.release();');
        const hub = read('components/VesselHub.tsx');
        expect(hub).toContain('data-testid="skipper-device-pi-primary"');
        expect(hub).toContain('publishes the boat · phones stand down');
        const service = read('services/CloudTelemetryService.ts');
        expect(service).toContain("if (NmeaStore.getState().connectionStatus === 'connected') return;");
        expect(service).toContain('CLOUD_TELEMETRY_LIVE_MAX_AGE_MS = 60_000');
    });

    it('the public page publishes an opted-in snapshot separately from the map position', () => {
        const fn = read('supabase/functions/voyage-log/index.ts');
        expect(fn).toContain(".from('vessel_telemetry')");
        expect(fn).toContain('if (instrumentsAllowed && boatId)');
        expect(fn).toContain('instruments = publicInstrumentSnapshot');
        expect(fn).toContain('telemetry: instrumentsEnabled ? telemetry : redactPublicTelemetry(telemetry)');
    });
});
