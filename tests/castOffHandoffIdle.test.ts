/**
 * castOffHandoffIdle — the drain for Cast Off's fire-and-forget background work.
 *
 * CastOffPanel and the Log page start GPS / route-line / publish chains they
 * deliberately never await (the work must outlive the panel that started it).
 * Each chain walks several dynamic imports, so a test that ends mid-chain
 * leaves imports running into the next test or past its environment's
 * teardown — the unhandled EnvironmentTeardownError that turned a fully
 * green single-worker run red. Tests drain with this before they tear down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    start: vi.fn(),
    status: vi.fn(),
    stop: vi.fn(),
    follow: vi.fn(),
    publish: vi.fn(),
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { startTracking: harness.start, getTrackingStatus: harness.status, stopTracking: harness.stop },
}));
vi.mock('../stores/followRouteStore', () => ({
    useFollowRouteStore: { getState: () => ({ isFollowing: false, voyageId: null }) },
}));
vi.mock('../services/shiplog/followCastOffRoute', () => ({ followCastOffRoute: harness.follow }));
vi.mock('../services/shiplog/publishFollowedRoute', () => ({ publishFollowedRoute: harness.publish }));
vi.mock('../services/routeTracer', () => ({
    loadSavedTraces: () => [{ id: 'route-idle', name: 'Idle route', plannedRouteId: 'planned-idle' }],
    displayRouteLabel: (trace: { name: string }) => trace.name,
    linkTraceToPassage: vi.fn(),
}));

import {
    castOffHandoffIdle,
    clearCastOffHandoff,
    ensureActiveVoyageLogging,
    peekCastOffHandoff,
    retryPublicPublish,
    stashCastOffHandoff,
    startHandoffGps,
} from '../services/castOffHandoff';

/** Every parked deferred, so a failing test cannot leave a chain parked
 *  forever and hang the next drain. */
const parked: Array<() => void> = [];

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    parked.push(() => resolve(undefined as T));
    return { promise, resolve };
}

/** One full macrotask: every microtask continuation queued so far has run. */
const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function watchIdle() {
    const state = { idle: false };
    const drained = castOffHandoffIdle().then(() => {
        state.idle = true;
    });
    return { state, drained };
}

beforeEach(() => {
    vi.clearAllMocks();
    clearCastOffHandoff();
    harness.status.mockReturnValue({ isTracking: true, currentVoyageId: 'voyage-idle' });
    harness.start.mockResolvedValue(undefined);
    harness.follow.mockResolvedValue(null);
    harness.publish.mockResolvedValue('linked');
});

afterEach(async () => {
    vi.useRealTimers();
    for (const release of parked.splice(0)) release();
    await castOffHandoffIdle();
    clearCastOffHandoff();
});

/** How long a stuck-drain test may run before Vitest calls it: far above the
 *  50 ms drain bound, far below the 20 s config default, so a drain that
 *  never gives up fails in seconds instead of sitting out the full timeout. */
const STUCK_TEST_TIMEOUT_MS = 2_000;

describe('castOffHandoffIdle', () => {
    it('resolves before the next macrotask when no background work is in flight', async () => {
        const first = await Promise.race([
            castOffHandoffIdle().then(() => 'idle'),
            nextMacrotask().then(() => 'timer'),
        ]);
        expect(first).toBe('idle');
    });

    it('waits for a fire-and-forget GPS start AND the further work that chain spawns', async () => {
        stashCastOffHandoff({ voyageId: 'voyage-idle', voyageName: 'Idle test', caution: null, publishRoute: false });
        const spawnedStart = deferred();
        harness.start
            // Mid-flight, the first chain starts more background work without
            // awaiting it — the way the auto-retry ladder re-enters
            // startHandoffGps from module level.
            .mockImplementationOnce(async () => {
                void startHandoffGps(true);
            })
            .mockImplementationOnce(() => spawnedStart.promise);

        void startHandoffGps();
        const { state, drained } = watchIdle();

        await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(2));
        // The first chain has settled by now; only the spawned one is parked.
        await nextMacrotask();
        expect(state.idle).toBe(false);

        spawnedStart.resolve();
        await drained;
        expect(state.idle).toBe(true);
        expect(peekCastOffHandoff()).toMatchObject({ voyageId: 'voyage-idle', gps: 'confirmed' });
    });

    it("waits for the Open Ship's Log door while its route line is still arming", async () => {
        const follow = deferred<string | null>();
        harness.follow.mockReturnValueOnce(follow.promise);

        void ensureActiveVoyageLogging({ id: 'voyage-idle', voyage_name: 'Idle test' });
        const { state, drained } = watchIdle();

        await vi.waitFor(() => expect(harness.follow).toHaveBeenCalledTimes(1));
        await nextMacrotask();
        expect(state.idle).toBe(false);

        follow.resolve(null);
        await drained;
        expect(peekCastOffHandoff()).toMatchObject({ voyageId: 'voyage-idle', gps: 'confirmed' });
    });

    it("waits for the Log page's public-publish retry", async () => {
        stashCastOffHandoff({
            voyageId: 'voyage-idle',
            voyageName: 'Idle test',
            caution: null,
            savedRouteId: 'route-idle',
        });
        const publish = deferred<string>();
        harness.publish.mockReturnValueOnce(publish.promise);

        void retryPublicPublish();
        const { state, drained } = watchIdle();

        await vi.waitFor(() => expect(harness.publish).toHaveBeenCalledWith('planned-idle'));
        await nextMacrotask();
        expect(state.idle).toBe(false);

        publish.resolve('linked');
        await drained;
        expect(peekCastOffHandoff()).toMatchObject({ publishState: 'linked' });
    });
});

describe('castOffHandoffIdle — bounded, and names what is stuck', () => {
    it(
        'rejects after timeoutMs naming startHandoffGps when startTracking never resolves',
        async () => {
            stashCastOffHandoff({
                voyageId: 'voyage-idle',
                voyageName: 'Idle test',
                caution: null,
                publishRoute: false,
            });
            // Never resolves inside this test; afterEach releases it so the
            // chain can finish before the next test.
            harness.start.mockImplementationOnce(() => deferred().promise);

            void startHandoffGps();
            await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

            await expect(castOffHandoffIdle({ timeoutMs: 50 })).rejects.toThrow(
                /still in flight after 50 ms: startHandoffGps\(retry=false\)/,
            );
            // Still genuinely stuck — the bound reported it, it did not settle it.
            expect(peekCastOffHandoff()).toMatchObject({ gps: 'starting' });
        },
        STUCK_TEST_TIMEOUT_MS,
    );

    it(
        "names the Open Ship's Log door and the publish retry — and only the work still in flight",
        async () => {
            stashCastOffHandoff({
                voyageId: 'voyage-idle',
                voyageName: 'Idle test',
                caution: null,
                savedRouteId: 'route-idle',
            });
            // A chain that finished before the drain began must not be named.
            await startHandoffGps(true);
            harness.publish.mockClear();
            harness.publish.mockImplementationOnce(() => deferred<string>().promise);
            harness.follow.mockImplementationOnce(() => deferred<string | null>().promise);

            void retryPublicPublish();
            void ensureActiveVoyageLogging({ id: 'voyage-idle', voyage_name: 'Idle test' });
            await vi.waitFor(() => {
                expect(harness.publish).toHaveBeenCalledWith('planned-idle');
                expect(harness.follow).toHaveBeenCalledTimes(1);
            });

            const failure = await castOffHandoffIdle({ timeoutMs: 50 }).then(
                () => null,
                (error: unknown) => error,
            );
            expect(failure).toBeInstanceOf(Error);
            const message = (failure as Error).message;
            expect(message).toContain('ensureActiveVoyageLogging(voyage-idle)');
            expect(message).toContain('retryPublicPublish');
            expect(message).not.toContain('startHandoffGps');
        },
        STUCK_TEST_TIMEOUT_MS,
    );

    it(
        'keeps its deadline on real time when a test has installed fake timers',
        async () => {
            stashCastOffHandoff({
                voyageId: 'voyage-idle',
                voyageName: 'Idle test',
                caution: null,
                publishRoute: false,
            });
            harness.start.mockImplementationOnce(() => deferred().promise);
            void startHandoffGps(true);
            await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));

            // Installed AFTER the module loaded: a deadline built on the
            // global setTimeout would now be frozen and never fire.
            vi.useFakeTimers();
            await expect(castOffHandoffIdle({ timeoutMs: 50 })).rejects.toThrow(/startHandoffGps\(retry=true\)/);
        },
        STUCK_TEST_TIMEOUT_MS,
    );
});
