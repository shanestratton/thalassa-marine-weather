import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The second device's view of a passage the account runs elsewhere (Shane
 * 2026-09-08: "if you connect to supabase from another device, and you already
 * have a route in the log page, can we make it so that it shows in the new
 * device"). Pure description first, then the fetch + cache around it.
 */
const h = vi.hoisted(() => ({
    getActiveVoyage: vi.fn<() => Promise<unknown>>(),
    getPlanLink: vi.fn<(voyageId: string) => Promise<unknown>>(),
}));
vi.mock('../services/VoyageService', () => ({ getActiveVoyage: h.getActiveVoyage }));
vi.mock('../services/VoyageLogService', () => ({ VoyageLogService: { getPlanLink: h.getPlanLink } }));

import {
    describeRemotePassage,
    fetchRemotePassage,
    readRemotePassageCache,
    remotePassageSinceLabel,
} from '../services/shiplog/remotePassage';
import { getDeviceId } from '../services/skipperDevice';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const NOW = Date.parse('2026-09-08T04:00:00.000Z');

const activeVoyage = (overrides: Record<string, unknown> = {}) => ({
    id: 'voyage-1',
    voyage_name: 'Newport → Whitsundays',
    status: 'active' as const,
    departure_port: 'Newport',
    destination_port: 'Airlie Beach',
    departure_time: '2026-09-08T01:14:00.000Z',
    saved_route_id: 'route-1',
    recording_device_id: 'dev-iphone',
    recording_device_name: "Shane's iPhone",
    ...overrides,
});

const link = (deviceId: string | null, planVoyageId = 'plan-1') => ({
    voyageId: 'voyage-1',
    planVoyageId,
    deviceId,
    deviceName: deviceId ? "Shane's iPhone" : null,
    updatedAt: deviceId ? '2026-09-08T01:15:00.000Z' : null,
});

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setAuthIdentityScope('skipper');
});

describe('describeRemotePassage', () => {
    it('names the recording device and the route another device published', () => {
        const passage = describeRemotePassage({
            voyage: activeVoyage(),
            link: link('dev-iphone'),
            myDeviceId: 'dev-ipad',
            trackingVoyageId: null,
            now: NOW,
        });
        expect(passage).toMatchObject({
            voyageId: 'voyage-1',
            voyageName: 'Newport → Whitsundays',
            recordingDeviceName: "Shane's iPhone",
            recordingDeviceId: 'dev-iphone',
            savedRouteId: 'route-1',
            linkHeldElsewhere: true,
        });
        expect(passage?.link?.planVoyageId).toBe('plan-1');
    });

    it('is nothing remote when THIS device records the voyage', () => {
        expect(
            describeRemotePassage({
                voyage: activeVoyage(),
                link: link('dev-iphone'),
                myDeviceId: 'dev-ipad',
                trackingVoyageId: 'voyage-1',
                now: NOW,
            }),
        ).toBeNull();
    });

    it('is nothing remote when this device cast off and merely is not tracking right now', () => {
        expect(
            describeRemotePassage({
                voyage: activeVoyage({ recording_device_id: 'dev-ipad' }),
                link: null,
                myDeviceId: 'dev-ipad',
                trackingVoyageId: null,
                now: NOW,
            }),
        ).toBeNull();
    });

    it('is nothing without an ACTIVE voyage', () => {
        expect(
            describeRemotePassage({
                voyage: activeVoyage({ status: 'planning' }),
                link: null,
                myDeviceId: 'dev-ipad',
                trackingVoyageId: null,
                now: NOW,
            }),
        ).toBeNull();
        expect(
            describeRemotePassage({
                voyage: null,
                link: null,
                myDeviceId: 'dev-ipad',
                trackingVoyageId: null,
                now: NOW,
            }),
        ).toBeNull();
    });

    it('a pre-stamp voyage (no recording device) is still shown as remote, recorder unknown', () => {
        const passage = describeRemotePassage({
            voyage: activeVoyage({ recording_device_id: null, recording_device_name: null }),
            link: link(null),
            myDeviceId: 'dev-ipad',
            trackingVoyageId: null,
            now: NOW,
        });
        expect(passage?.recordingDeviceName).toBeNull();
        expect(passage?.linkHeldElsewhere).toBe(false); // unstamped link belongs to nobody
    });

    it('ignores a link row for a different voyage', () => {
        const passage = describeRemotePassage({
            voyage: activeVoyage(),
            link: { ...link('dev-iphone'), voyageId: 'voyage-old' },
            myDeviceId: 'dev-ipad',
            trackingVoyageId: null,
            now: NOW,
        });
        expect(passage?.link).toBeNull();
    });
});

describe('fetchRemotePassage', () => {
    it('reads the active voyage and its link, and caches the answer for the first paint', async () => {
        h.getActiveVoyage.mockResolvedValue(activeVoyage());
        h.getPlanLink.mockResolvedValue({ ok: true, row: link('dev-iphone') });
        const result = await fetchRemotePassage(null);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('unreachable');
        expect(result.passage?.recordingDeviceName).toBe("Shane's iPhone");
        expect(h.getPlanLink).toHaveBeenCalledWith('voyage-1');
        expect(readRemotePassageCache()?.voyageId).toBe('voyage-1');
    });

    it('a failed link read is a failed fetch — never "no route"', async () => {
        h.getActiveVoyage.mockResolvedValue(activeVoyage());
        h.getPlanLink.mockResolvedValue({ ok: false, reason: 'offline' });
        const result = await fetchRemotePassage(null);
        expect(result).toEqual({ ok: false, reason: 'offline' });
    });

    it('no active voyage clears the cache', async () => {
        h.getActiveVoyage.mockResolvedValue(activeVoyage());
        h.getPlanLink.mockResolvedValue({ ok: true, row: null });
        await fetchRemotePassage(null);
        expect(readRemotePassageCache()).not.toBeNull();
        h.getActiveVoyage.mockResolvedValue(null);
        const result = await fetchRemotePassage(null);
        expect(result).toEqual({ ok: true, passage: null });
        expect(readRemotePassageCache()).toBeNull();
    });

    it('does not read the link when the voyage is this device’s own', async () => {
        h.getActiveVoyage.mockResolvedValue(activeVoyage({ recording_device_id: getDeviceId() }));
        h.getPlanLink.mockResolvedValue({ ok: true, row: null });
        const result = await fetchRemotePassage(null);
        expect(result).toEqual({ ok: true, passage: null });
    });

    it('signed out asks nothing', async () => {
        setAuthIdentityScope(null);
        const result = await fetchRemotePassage(null);
        expect(result.ok).toBe(false);
        expect(h.getActiveVoyage).not.toHaveBeenCalled();
    });
});

describe('remotePassageSinceLabel', () => {
    it('says the time today and the weekday otherwise', () => {
        const today = new Date();
        today.setHours(9, 14, 0, 0);
        expect(remotePassageSinceLabel(today.toISOString())).toBe('since 09:14');
        const lastWeek = new Date(today.getTime() - 6 * 86_400_000);
        expect(remotePassageSinceLabel(lastWeek.toISOString())).toMatch(/^since [A-Z][a-z]{2} 09:14$/);
        expect(remotePassageSinceLabel(null)).toBe('');
        expect(remotePassageSinceLabel('garbage')).toBe('');
    });
});
