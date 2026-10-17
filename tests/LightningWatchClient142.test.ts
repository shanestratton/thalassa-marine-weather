import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), satellite: false }));
vi.mock('../services/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => mocks.satellite }));
import {
    fetchLightningWatchStatus,
    parseLightningWatchStatus,
    saveLightningWatch,
} from '../services/lightningWatchClient';
const OWNER = '00000000-0000-4000-8000-000000000001',
    BOAT = '00000000-0000-4000-8000-0000000000b1';
const REV = '00000000-0000-4000-8000-000000000011';
beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.satellite = false;
    setAuthIdentityScope(OWNER);
});
describe('lightning owner client boundary', () => {
    it('rejects malformed status and preserves explicit false permissions', () => {
        expect(parseLightningWatchStatus({ schema: 1, profile: null, ready: false, positionFresh: false })).toEqual({
            profile: null,
            ready: false,
            positionFresh: false,
        });
        for (const profile of [undefined, {}, { revision: REV, enabled: 'true' }])
            expect(parseLightningWatchStatus({ schema: 1, profile, ready: true, positionFresh: true })).toBeNull();
    });
    it('reads only the explicit boat and rejects an owner ABA response', async () => {
        let finish!: (value: unknown) => void;
        mocks.rpc.mockReturnValue(
            new Promise((done) => {
                finish = done;
            }),
        );
        const pending = fetchLightningWatchStatus(BOAT);
        setAuthIdentityScope('other');
        setAuthIdentityScope(OWNER);
        finish({ data: { schema: 1, profile: null, ready: true, positionFresh: true }, error: null });
        expect(await pending).toBeNull();
        expect(mocks.rpc).toHaveBeenCalledWith('lightning_watch_status', { p_boat_id: BOAT });
    });
    it('does no RPC over satellite or under a retired owner scope', async () => {
        const retired = getAuthIdentityScope();
        setAuthIdentityScope('other');
        await expect(saveLightningWatch(BOAT, null, true, retired)).rejects.toThrow('unavailable');
        mocks.satellite = true;
        expect(await fetchLightningWatchStatus(BOAT)).toBeNull();
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('sends exactly one CAS and requires an exact enabled result', async () => {
        mocks.rpc.mockResolvedValue({ data: { revision: REV, enabled: false }, error: null });
        await expect(saveLightningWatch(BOAT, null, true, getAuthIdentityScope())).rejects.toThrow('not confirmed');
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('configure_lightning_watch', {
            p_boat_id: BOAT,
            p_expected: null,
            p_enabled: true,
        });
    });
    it('reports a conflict without an automatic retry', async () => {
        mocks.rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
        await expect(saveLightningWatch(BOAT, REV, false, getAuthIdentityScope())).rejects.toThrow('another device');
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
    });
});
