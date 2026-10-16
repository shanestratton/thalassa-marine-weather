import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { declareEngineRunning, endEngineRunCounter, newEngineRunCounter } from '../services/shiplog/engineRunCounter';

const fake = vi.hoisted(() => ({
    identity: 'owner-a',
    binder: 'own',
    active: 'boat-a',
    queue: [] as { table_name: string; status: string }[],
    reading: Promise.resolve({ data: { user_id: 'owner-a', hours: 100 }, error: null }) as Promise<{
        data: unknown;
        error: unknown;
    }>,
    receipt: Promise.resolve({ data: null, error: null }) as Promise<{ data: unknown; error: unknown }>,
    rpc: vi.fn(),
    pull: vi.fn(async () => 0),
    from: vi.fn(),
}));
vi.mock('../services/vessel/LocalDatabase', () => ({
    getLocalDatabaseSession: () => ({ identity: fake.identity }),
    getFullQueue: () => fake.queue,
}));
vi.mock('../services/vessel/sharedBinders', () => ({ getBinderSource: () => ({ mode: fake.binder }) }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ activeVesselId: fake.active, vesselFleet: [{ id: 'boat-a', name: 'Example Boat' }] }),
    },
}));
vi.mock('../services/vessel/SyncService', () => ({ forceFullPull: fake.pull }));
vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => {
            fake.from(table);
            const chain = {
                select: () => chain,
                eq: () => chain,
                abortSignal: () => chain,
                maybeSingle: () => (table === 'vessel_engine_hours' ? fake.reading : fake.receipt),
            };
            return chain;
        },
        rpc: (...args: unknown[]) => ({ abortSignal: () => fake.rpc(...args) }),
    },
}));
import {
    confirmEngineHours,
    loadEngineHoursReview,
    type EngineHoursOffer,
} from '../services/shiplog/engineHoursReview';
import { requestEngineHoursReview, ENGINE_HOURS_REVIEW_EVENT } from '../services/shiplog/engineHoursOffer';
const T = 1_800_000_000_000;
function offer(): EngineHoursOffer {
    return {
        scope: setAuthIdentityScope('owner-a'),
        boatId: 'boat-a',
        counter: endEngineRunCounter(
            declareEngineRunning(newEngineRunCounter('voyage_demo', T), true, T),
            T + 1800_000,
        ),
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    fake.identity = 'owner-a';
    fake.binder = 'own';
    fake.active = 'boat-a';
    fake.queue = [];
    fake.reading = Promise.resolve({ data: { user_id: 'owner-a', hours: 100 }, error: null });
    fake.receipt = Promise.resolve({ data: null, error: null });
    fake.rpc.mockResolvedValue({ data: { applied: true, hours: 100, remainderSeconds: 1800 }, error: null });
});
describe('explicit engine hours review', () => {
    it('offers a local ended counter without any provider read or meter write', () => {
        const candidate = offer();
        const receive = vi.fn();
        window.addEventListener(ENGINE_HOURS_REVIEW_EVENT, receive);
        try {
            requestEngineHoursReview(candidate.counter, candidate.boatId);
            expect(receive).toHaveBeenCalledOnce();
            expect((receive.mock.calls[0][0] as CustomEvent).detail.boatId).toBe('boat-a');
            expect(fake.from).not.toHaveBeenCalled();
            expect(fake.rpc).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener(ENGINE_HOURS_REVIEW_EVENT, receive);
        }
    });
    it('reads the owner meter and durable receipt before explicit confirmation', async () => {
        const candidate = offer();
        expect(await loadEngineHoursReview(candidate, new AbortController().signal)).toEqual({
            hours: 100,
            alreadyConfirmed: false,
        });
        expect(fake.rpc).not.toHaveBeenCalled();
        fake.receipt = Promise.resolve({ data: { voyage_id: 'voyage_demo' }, error: null });
        expect((await loadEngineHoursReview(candidate, new AbortController().signal)).alreadyConfirmed).toBe(true);
    });
    it.each(['pending', 'syncing', 'failed'])(
        'refuses a %s local absolute meter write rather than racing it',
        async (status) => {
            const candidate = offer();
            fake.queue = [{ table_name: 'vessel_engine_hours', status }];
            await expect(confirmEngineHours(candidate, 100, new AbortController().signal)).rejects.toThrow(
                'pending engine-hour edit',
            );
            expect(fake.rpc).not.toHaveBeenCalled();
        },
    );
    it('refuses another active boat or shared maintenance binder', async () => {
        const candidate = offer();
        fake.active = 'boat-b';
        await expect(loadEngineHoursReview(candidate, new AbortController().signal)).rejects.toThrow('Switch back');
        fake.active = 'boat-a';
        fake.binder = 'shared';
        await expect(confirmEngineHours(candidate, 100, new AbortController().signal)).rejects.toThrow('own boat');
        expect(fake.rpc).not.toHaveBeenCalled();
    });
    it('rejects old account results after an ignored abort or slow read', async () => {
        const candidate = offer();
        let finish!: (v: { data: unknown; error: unknown }) => void;
        fake.reading = new Promise((resolve) => (finish = resolve));
        const pending = loadEngineHoursReview(candidate, new AbortController().signal);
        setAuthIdentityScope('owner-b');
        finish({ data: { user_id: 'owner-a', hours: 100 }, error: null });
        await expect(pending).rejects.toThrow('Account changed');
    });
    it('does not substitute another owner or malformed meter reading', async () => {
        const candidate = offer();
        fake.reading = Promise.resolve({ data: { user_id: 'owner-b', hours: 100 }, error: null });
        await expect(loadEngineHoursReview(candidate, new AbortController().signal)).rejects.toThrow('needs review');
        fake.reading = Promise.resolve({ data: { user_id: 'owner-a', hours: 100.5 }, error: null });
        await expect(loadEngineHoursReview(candidate, new AbortController().signal)).rejects.toThrow('needs review');
    });
    it('sends one source-labelled cumulative confirmation and refreshes without a second meter write', async () => {
        const candidate = offer();
        const result = await confirmEngineHours(candidate, 100, new AbortController().signal);
        expect(result).toEqual({ applied: true, hours: 100, remainderSeconds: 1800 });
        expect(fake.rpc).toHaveBeenCalledWith('confirm_voyage_engine_hours', {
            p_voyage_id: 'voyage_demo',
            p_seconds: 1800,
            p_source: 'log',
            p_expected_hours: 100,
        });
        await vi.waitFor(() => expect(fake.pull).toHaveBeenCalledOnce());
    });
    it('never confirms a clock-uncertain counter or an aborted request', async () => {
        const candidate = offer();
        candidate.counter = { ...candidate.counter, clockUncertain: true };
        await expect(confirmEngineHours(candidate, 100, new AbortController().signal)).rejects.toThrow('clock change');
        candidate.counter = { ...candidate.counter, clockUncertain: false };
        const abort = new AbortController();
        abort.abort();
        await expect(confirmEngineHours(candidate, 100, abort.signal)).rejects.toThrow('cancelled');
        expect(fake.rpc).not.toHaveBeenCalled();
    });
    it('requires a new review after another device changes the meter', async () => {
        const candidate = offer();
        fake.rpc.mockResolvedValue({ data: null, error: { code: '40001' } });
        await expect(confirmEngineHours(candidate, 100, new AbortController().signal)).rejects.toThrow('changed');
    });
});
