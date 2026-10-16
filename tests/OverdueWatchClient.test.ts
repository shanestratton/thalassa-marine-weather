import { beforeEach, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), satellite: false }));
vi.mock('../services/supabase', () => ({ supabase: { rpc: mock.rpc } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => mock.satellite }));
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    loadOverdueStatus,
    saveOverdueWatch,
    endOverdueWatch,
    parseOverdueStatus,
} from '../services/overdueWatchClient';
const owner = '10000000-0000-4000-8000-000000000001',
    boat = '20000000-0000-4000-8000-000000000001',
    revision = '30000000-0000-4000-8000-000000000001';
const cfg = () => ({
    enabled: true,
    plan: {
        vesselLabel: 'Fixture yacht',
        from: 'A',
        to: 'B',
        departureAt: Date.now() - 10000,
        etaAt: null,
        overdueAt: Date.now() + 3600000,
        persons: 2,
    },
    contacts: [{ id: owner, revision }],
    sharePosition: false,
    rescueRegion: null,
});
const status = () => ({
    schema: 1,
    ownerId: owner,
    boatId: boat,
    checkedAt: Date.now(),
    ready: true,
    watch: {
        revision,
        configuration: cfg(),
        state: { ownerQueuedAt: null, ownerAttemptedAt: null, contactsQueuedAt: null, endedAt: null },
        endReason: null,
        reviewRequired: false,
    },
});
beforeEach(() => {
    setAuthIdentityScope(owner);
    mock.rpc.mockReset();
    mock.satellite = false;
});
it('exact owner/boat/status clocks and compact shape only; no implicit attempt or arrival', () => {
    const scope = getAuthIdentityScope();
    expect(parseOverdueStatus(status(), boat, scope)).not.toBeNull();
    for (const patch of [
        { ownerId: boat },
        { boatId: owner },
        { checkedAt: Date.now() + 1000 },
        { checkedAt: Date.now() - 61000 },
        { ready: 'true' },
        { rawRoute: [] },
        { watch: { ...status().watch, state: { ...status().watch.state, ownerAttemptedAt: 0 } } },
        { watch: { ...status().watch, endReason: 'arrived' } },
    ])
        expect(parseOverdueStatus({ ...status(), ...patch }, boat, scope)).toBeNull();
});
it('Satellite Mode makes no background or explicit WAN read/mutation', async () => {
    mock.satellite = true;
    expect(await loadOverdueStatus(boat)).toBeNull();
    await expect(saveOverdueWatch(boat, null, cfg(), getAuthIdentityScope())).rejects.toThrow();
    await expect(endOverdueWatch(boat, revision, 'arrived', getAuthIdentityScope())).rejects.toThrow();
    expect(mock.rpc).not.toHaveBeenCalled();
});
it('late source completion cannot escape owner/account retirement', async () => {
    for (const action of ['load', 'save', 'end']) {
        setAuthIdentityScope(owner);
        const scope = getAuthIdentityScope();
        let done!: (v: unknown) => void;
        mock.rpc.mockImplementation(
            () =>
                new Promise((r) => {
                    done = r;
                }),
        );
        const p =
            action === 'load'
                ? loadOverdueStatus(boat, scope)
                : action === 'save'
                  ? saveOverdueWatch(boat, revision, cfg(), scope)
                  : endOverdueWatch(boat, revision, 'cancelled', scope);
        setAuthIdentityScope(boat);
        done({ data: action === 'load' ? status() : revision, error: null });
        if (action === 'load') expect(await p).toBeNull();
        else await expect(p).rejects.toThrow('changed');
    }
});
it('uses exact CAS and explicit arrived/cancel action without retrying a conflict', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
    await expect(endOverdueWatch(boat, revision, 'arrived', getAuthIdentityScope())).rejects.toThrow('another phone');
    expect(mock.rpc).toHaveBeenCalledOnce();
    expect(mock.rpc).toHaveBeenCalledWith('end_overdue_watch', {
        p_boat_id: boat,
        p_expected: revision,
        p_reason: 'arrived',
    });
    mock.rpc.mockClear();
    await expect(
        saveOverdueWatch(
            boat,
            revision,
            { ...cfg(), plan: { ...cfg().plan, overdueAt: Date.now() } },
            getAuthIdentityScope(),
        ),
    ).rejects.toThrow('future');
    expect(mock.rpc).not.toHaveBeenCalled();
});
