import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Followed-route authorship (Shane 2026-09-08): "if you connect to supabase
 * from another device, and you already have a route in the log page, can we
 * make it so that it shows in the new device. otherwise they can overwrite
 * it." Link rows now name the device that wrote them; this device reads that
 * before it writes, names the other device instead of overwriting, and only
 * clears links it set itself. Nothing refuses the skipper — `replace` gets
 * through unconditionally once the confirm has named the other device.
 */

const h = vi.hoisted(() => ({
    setVoyagePlanLink: vi.fn<(voyageId: string, planId: string | null) => Promise<boolean>>(),
    getPlanLink: vi.fn<(voyageId: string) => Promise<unknown>>(),
    tracking: true,
    currentVoyageId: 'voyage-1' as string | undefined,
}));

vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: { setVoyagePlanLink: h.setVoyagePlanLink, getPlanLink: h.getPlanLink },
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getTrackingStatus: () => ({
            isTracking: h.tracking,
            isPaused: false,
            isRapidMode: false,
            isPrecisionMode: false,
        }),
        getCurrentVoyageId: () => h.currentVoyageId,
    },
}));

import {
    PLAN_LINK_INTENT_DROPPED_EVENT,
    clearPlanLinkIfWrittenHere,
    flushPlanLinkIntents,
    markWrittenHere,
    resetPlanLinkIntentsForTest,
    setPlanLinkWithRetry,
    wroteLinkHere,
    type PlanLinkIntentDropped,
} from '../services/shiplog/planLinkIntent';
import { clearFollowedRoute, publishFollowedRouteDetailed } from '../services/shiplog/publishFollowedRoute';
import { getDeviceId } from '../services/skipperDevice';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

const ledgerRaw = () => localStorage.getItem(authScopedStorageKey('thalassa_plan_link_intents_v1'));

const otherPhone = (planVoyageId: string) => ({
    ok: true,
    row: {
        voyageId: 'voyage-1',
        planVoyageId,
        deviceId: 'dev-other-phone',
        deviceName: "Shane's iPad · 9c1e",
        updatedAt: '2026-09-08T03:00:00.000Z',
    },
});

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetPlanLinkIntentsForTest();
    setAuthIdentityScope('skipper');
    h.tracking = true;
    h.currentVoyageId = 'voyage-1';
    h.setVoyagePlanLink.mockResolvedValue(true);
    h.getPlanLink.mockResolvedValue({ ok: true, row: null });
});

describe('publishFollowedRoute — who holds the route on the active voyage', () => {
    it('with no link standing it writes, and remembers this device authored it', async () => {
        const outcome = await publishFollowedRouteDetailed('plan-a');
        expect(outcome).toEqual({ result: 'linked' });
        expect(h.getPlanLink).toHaveBeenCalledWith('voyage-1');
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-1', 'plan-a');
        expect(wroteLinkHere('voyage-1')).toBe(true);
    });

    it("another device's DIFFERENT route stands → 'held-elsewhere' naming it, nothing written", async () => {
        h.getPlanLink.mockResolvedValue(otherPhone('plan-b'));
        const outcome = await publishFollowedRouteDetailed('plan-a');
        expect(outcome.result).toBe('held-elsewhere');
        expect(outcome.hold).toEqual({
            voyageId: 'voyage-1',
            planVoyageId: 'plan-b',
            deviceName: "Shane's iPad · 9c1e",
            updatedAt: '2026-09-08T03:00:00.000Z',
        });
        expect(h.setVoyagePlanLink).not.toHaveBeenCalled();
        expect(ledgerRaw()).toBeNull(); // nothing queued either — the skipper decides
        expect(wroteLinkHere('voyage-1')).toBe(false);
    });

    it("another device already published the SAME route → 'linked' without re-stamping it as ours", async () => {
        h.getPlanLink.mockResolvedValue(otherPhone('plan-a'));
        const outcome = await publishFollowedRouteDetailed('plan-a');
        expect(outcome).toEqual({ result: 'linked' });
        expect(h.setVoyagePlanLink).not.toHaveBeenCalled();
        expect(wroteLinkHere('voyage-1')).toBe(false);
    });

    it('a confirmed replace overwrites without reading — the skipper has already been told', async () => {
        h.getPlanLink.mockResolvedValue(otherPhone('plan-b'));
        const outcome = await publishFollowedRouteDetailed('plan-a', { replace: true });
        expect(outcome).toEqual({ result: 'linked' });
        expect(h.getPlanLink).not.toHaveBeenCalled();
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-1', 'plan-a');
        expect(wroteLinkHere('voyage-1')).toBe(true);
    });

    it('re-linking a voyage this device authored skips the read (its own link, as before)', async () => {
        markWrittenHere('voyage-1', 'plan-old');
        const outcome = await publishFollowedRouteDetailed('plan-new');
        expect(outcome).toEqual({ result: 'linked' });
        expect(h.getPlanLink).not.toHaveBeenCalled();
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-1', 'plan-new');
    });

    it('offline and not the author → queued WITHOUT a blind write; the flush decides on reconnect', async () => {
        h.getPlanLink.mockResolvedValue({ ok: false, reason: 'offline' });
        const outcome = await publishFollowedRouteDetailed('plan-a');
        expect(outcome).toEqual({ result: 'queued' });
        expect(h.setVoyagePlanLink).not.toHaveBeenCalled();
        expect(ledgerRaw()).toContain('plan-a');
    });

    it('forVoyageId links the account’s active voyage while this device records nothing', async () => {
        h.tracking = false;
        h.currentVoyageId = undefined;
        const outcome = await publishFollowedRouteDetailed('plan-a', { forVoyageId: 'voyage-remote' });
        expect(outcome).toEqual({ result: 'linked' });
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-remote', 'plan-a');
    });

    it('an unstamped (pre-migration) row belongs to nobody and is replaced as it always was', async () => {
        h.getPlanLink.mockResolvedValue({
            ok: true,
            row: { voyageId: 'voyage-1', planVoyageId: 'plan-old', deviceId: null, deviceName: null, updatedAt: null },
        });
        const outcome = await publishFollowedRouteDetailed('plan-a');
        expect(outcome).toEqual({ result: 'linked' });
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-1', 'plan-a');
    });

    it("this device's own stamp is not foreign", async () => {
        h.getPlanLink.mockResolvedValue({
            ok: true,
            row: {
                voyageId: 'voyage-1',
                planVoyageId: 'plan-old',
                deviceId: getDeviceId(),
                deviceName: 'me',
                updatedAt: '2026-09-08T03:00:00.000Z',
            },
        });
        const outcome = await publishFollowedRouteDetailed('plan-a');
        expect(outcome).toEqual({ result: 'linked' });
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-1', 'plan-a');
    });
});

describe('flush — a queued intent never overwrites or deletes another device’s link', () => {
    it('drops a queued link when the other device set a different route, and says who', async () => {
        h.setVoyagePlanLink.mockResolvedValueOnce(false); // dead spot: intent queued
        await setPlanLinkWithRetry('voyage-1', 'plan-a');
        expect(ledgerRaw()).toContain('plan-a');
        expect(wroteLinkHere('voyage-1')).toBe(true);

        const dropped: PlanLinkIntentDropped[] = [];
        window.addEventListener(PLAN_LINK_INTENT_DROPPED_EVENT, (event) =>
            dropped.push((event as CustomEvent<PlanLinkIntentDropped>).detail),
        );
        h.getPlanLink.mockResolvedValue(otherPhone('plan-b'));
        h.setVoyagePlanLink.mockClear();
        await flushPlanLinkIntents();

        expect(h.setVoyagePlanLink).not.toHaveBeenCalled();
        expect(ledgerRaw()).toBeNull();
        expect(wroteLinkHere('voyage-1')).toBe(false);
        expect(dropped).toEqual([
            {
                voyageId: 'voyage-1',
                planVoyageId: 'plan-a',
                holderName: "Shane's iPad · 9c1e",
                holderPlanVoyageId: 'plan-b',
            },
        ]);
    });

    it('drops a queued CLEAR when another device has since set a route (their stop clears it)', async () => {
        markWrittenHere('voyage-1', 'plan-a');
        h.setVoyagePlanLink.mockResolvedValueOnce(false);
        await setPlanLinkWithRetry('voyage-1', null);
        expect(ledgerRaw()).toContain('voyage-1');

        h.getPlanLink.mockResolvedValue(otherPhone('plan-b'));
        h.setVoyagePlanLink.mockClear();
        await flushPlanLinkIntents();
        expect(h.setVoyagePlanLink).not.toHaveBeenCalled();
        expect(ledgerRaw()).toBeNull();
    });

    it('keeps the intent when the row cannot be read — it never writes blind', async () => {
        h.setVoyagePlanLink.mockResolvedValueOnce(false);
        await setPlanLinkWithRetry('voyage-1', 'plan-a');
        h.getPlanLink.mockResolvedValue({ ok: false, reason: 'offline' });
        h.setVoyagePlanLink.mockClear();
        await flushPlanLinkIntents();
        expect(h.setVoyagePlanLink).not.toHaveBeenCalled();
        expect(ledgerRaw()).toContain('plan-a');
    });

    it('applies the intent when no link stands or the standing one is ours', async () => {
        h.setVoyagePlanLink.mockResolvedValueOnce(false);
        await setPlanLinkWithRetry('voyage-1', 'plan-a');
        await flushPlanLinkIntents();
        expect(h.setVoyagePlanLink).toHaveBeenLastCalledWith('voyage-1', 'plan-a');
        expect(ledgerRaw()).toBeNull();
    });
});

describe('stopping — only the device that set the link clears it', () => {
    it('clears a link this device wrote without reading', async () => {
        markWrittenHere('voyage-1', 'plan-a');
        await expect(clearPlanLinkIfWrittenHere('voyage-1')).resolves.toBe('cleared');
        expect(h.getPlanLink).not.toHaveBeenCalled();
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-1', null);
        expect(wroteLinkHere('voyage-1')).toBe(false);
    });

    it("leaves another device's link standing", async () => {
        h.getPlanLink.mockResolvedValue(otherPhone('plan-b'));
        await expect(clearPlanLinkIfWrittenHere('voyage-1')).resolves.toBe('held-elsewhere');
        expect(h.setVoyagePlanLink).not.toHaveBeenCalled();
    });

    it('clears an unstamped pre-migration link from any device (the old behaviour)', async () => {
        h.getPlanLink.mockResolvedValue({
            ok: true,
            row: { voyageId: 'voyage-1', planVoyageId: 'plan-old', deviceId: null, deviceName: null, updatedAt: null },
        });
        await expect(clearPlanLinkIfWrittenHere('voyage-1')).resolves.toBe('cleared');
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-1', null);
    });

    it("'unknown' when it did not author the link and cannot read the row — nothing queued", async () => {
        h.getPlanLink.mockResolvedValue({ ok: false, reason: 'offline' });
        await expect(clearPlanLinkIfWrittenHere('voyage-1')).resolves.toBe('unknown');
        expect(h.setVoyagePlanLink).not.toHaveBeenCalled();
        expect(ledgerRaw()).toBeNull();
    });

    it('"Just recording" on the second phone does not un-publish the first phone’s route', async () => {
        h.getPlanLink.mockResolvedValue(otherPhone('plan-b'));
        await expect(clearFollowedRoute()).resolves.toBe(false);
        expect(h.setVoyagePlanLink).not.toHaveBeenCalled();
    });
});
