import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * planLinkIntent — the durable-intent ledger behind the public followed-route
 * link (hardening 2026-08-01). voyage_plan_links had five writers and zero
 * retries: cast off in a wifi shadow and the public page silently never showed
 * the route; stop offline at the anchorage and the ended passage stayed
 * published. The ledger records intent before attempting and flushes on
 * reconnect, with last-intent-per-voyage-wins making a late flush unable to
 * resurrect a link the stop path meant to delete.
 */

const h = vi.hoisted(() => ({
    setVoyagePlanLink: vi.fn<(voyageId: string, planId: string | null) => Promise<boolean>>(),
}));

vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: { setVoyagePlanLink: h.setVoyagePlanLink },
}));

import {
    setPlanLinkWithRetry,
    flushPlanLinkIntents,
    resetPlanLinkIntentsForTest,
} from '../services/shiplog/planLinkIntent';
import { setAuthIdentityScope, authScopedStorageKey } from '../services/authIdentityScope';

const ledgerRaw = () => localStorage.getItem(authScopedStorageKey('thalassa_plan_link_intents_v1'));

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetPlanLinkIntentsForTest();
    setAuthIdentityScope('skipper');
    h.setVoyagePlanLink.mockResolvedValue(true);
});

describe('planLinkIntent — durable retry for the public route link', () => {
    it('a successful write leaves no residue', async () => {
        const ok = await setPlanLinkWithRetry('voyage-1', 'planned-1');
        expect(ok).toBe(true);
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-1', 'planned-1');
        expect(ledgerRaw()).toBeNull();
    });

    it('a failed write persists the intent and the online event flushes it', async () => {
        h.setVoyagePlanLink.mockResolvedValueOnce(false);
        const ok = await setPlanLinkWithRetry('voyage-1', 'planned-1');
        expect(ok).toBe(false);
        expect(ledgerRaw()).toContain('planned-1'); // durably queued, not lost

        // Signal returns.
        h.setVoyagePlanLink.mockResolvedValue(true);
        window.dispatchEvent(new Event('online'));
        await vi.waitFor(() => expect(ledgerRaw()).toBeNull());
        expect(h.setVoyagePlanLink).toHaveBeenLastCalledWith('voyage-1', 'planned-1');
    });

    it('LAST intent per voyage wins — a stop-clear supersedes a queued cast-off link', async () => {
        // Cast-off link fails (dead spot)…
        h.setVoyagePlanLink.mockResolvedValue(false);
        await setPlanLinkWithRetry('voyage-1', 'planned-1');
        // …then the voyage STOPS, still offline: clear intent overwrites.
        await setPlanLinkWithRetry('voyage-1', null);

        // Reconnect: the flush must apply ONLY the clear — the dead link
        // intent must never resurrect the route on the ended passage.
        h.setVoyagePlanLink.mockClear();
        h.setVoyagePlanLink.mockResolvedValue(true);
        await flushPlanLinkIntents();

        expect(h.setVoyagePlanLink).toHaveBeenCalledTimes(1);
        expect(h.setVoyagePlanLink).toHaveBeenCalledWith('voyage-1', null);
        expect(ledgerRaw()).toBeNull();
    });

    it('a thrown write (network abort) is queued exactly like a false one', async () => {
        h.setVoyagePlanLink.mockRejectedValueOnce(new Error('socket closed'));
        const ok = await setPlanLinkWithRetry('voyage-1', 'planned-1');
        expect(ok).toBe(false);
        expect(ledgerRaw()).toContain('voyage-1');
    });

    it('an intent recorded mid-flush survives if it is newer than the one flushed', async () => {
        // Flush is applying planned-1 when the skipper re-picks planned-2.
        h.setVoyagePlanLink.mockResolvedValueOnce(false);
        await setPlanLinkWithRetry('voyage-1', 'planned-1');

        h.setVoyagePlanLink.mockImplementationOnce(async () => {
            // While the flush's write is in flight, a newer intent lands.
            const ledger = JSON.parse(ledgerRaw() as string) as Record<string, string | null>;
            ledger['voyage-1'] = 'planned-2';
            localStorage.setItem(authScopedStorageKey('thalassa_plan_link_intents_v1'), JSON.stringify(ledger));
            return true;
        });
        await flushPlanLinkIntents();

        // planned-2 must still be queued — the flush only removes ITS OWN intent.
        expect(ledgerRaw()).toContain('planned-2');
    });
});
