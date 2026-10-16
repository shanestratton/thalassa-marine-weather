import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), satellite: false }));
vi.mock('../services/supabase', () => ({ supabase: { rpc: mock.rpc } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => mock.satellite }));
import { listBuddyWatches, saveBuddyWatch, parseBuddyWatchList } from '../services/buddyWatchClient';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
const owner = '10000000-0000-4000-8000-000000000001',
    boat = '20000000-0000-4000-8000-000000000001',
    id = '30000000-0000-4000-8000-000000000001',
    revision = '40000000-0000-4000-8000-000000000001';
const config = () => ({ mmsi: 234567890, label: 'Fictional', enabled: false, area: null });
const list = () => ({
    schema: 1,
    ownerId: owner,
    boatId: boat,
    checkedAt: Date.now(),
    ready: false,
    watches: [{ id, revision, configuration: config(), state: null }],
});
beforeEach(() => {
    setAuthIdentityScope(owner);
    mock.rpc.mockReset();
    mock.satellite = false;
});
describe('owner-scoped bounded buddy RPC client', () => {
    it('refuses other owner/hull, extra fields, old proof and over-ten responses', () => {
        const scope = getAuthIdentityScope();
        expect(parseBuddyWatchList(list(), boat, scope)).not.toBeNull();
        for (const change of [
            { ownerId: 'other' },
            { boatId: id },
            { checkedAt: Date.now() - 61000 },
            { watches: Array.from({ length: 11 }, () => list().watches[0]) },
            { watches: [{ ...list().watches[0], raw: { position: [0, 0] } }] },
            { rawUrl: 'https://bad' },
        ])
            expect(parseBuddyWatchList({ ...list(), ...change }, boat, scope)).toBeNull();
    });
    it('does no WAN in Satellite Mode, including explicit list/save attempts', async () => {
        mock.satellite = true;
        expect(await listBuddyWatches(boat)).toBeNull();
        await expect(saveBuddyWatch(boat, null, config(), getAuthIdentityScope())).rejects.toThrow();
        expect(mock.rpc).not.toHaveBeenCalled();
    });
    it('drops an in-flight account-A list before accountB can see it', async () => {
        let done!: (v: unknown) => void;
        mock.rpc.mockImplementation(() => new Promise((r) => (done = r)));
        const pending = listBuddyWatches(boat);
        setAuthIdentityScope(id);
        done({ data: list(), error: null });
        expect(await pending).toBeNull();
    });
    it('sends only explicit fixed owner/boat CAS configuration and never retries conflicts', async () => {
        mock.rpc.mockResolvedValue({ data: revision, error: null });
        await saveBuddyWatch(boat, null, config(), getAuthIdentityScope());
        expect(mock.rpc).toHaveBeenCalledWith('configure_buddy_watch', {
            p_boat_id: boat,
            p_watch_id: null,
            p_expected: null,
            p_configuration: config(),
        });
        mock.rpc.mockReset().mockResolvedValue({ data: null, error: { code: '40001' } });
        await expect(saveBuddyWatch(boat, { id, revision }, config(), getAuthIdentityScope())).rejects.toThrow(
            'another phone',
        );
        expect(mock.rpc).toHaveBeenCalledTimes(1);
    });
});
