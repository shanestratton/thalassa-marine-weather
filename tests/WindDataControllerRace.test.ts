import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {
        current: {
            isGlobalMode: true,
            model: 'ecmwf',
            field: 'wind',
            grid: null as unknown,
            loading: false,
            error: null as string | null,
            localGribPath: null as string | null,
            hour: 0,
            totalHours: 0,
        },
    },
    fetchModelWindGrid: vi.fn(),
    fetchWindGrid: vi.fn(),
    fetchGlobalWindField: vi.fn(),
    loadLocalWindFile: vi.fn(),
    setGrid: vi.fn(),
    setLoading: vi.fn(),
    setError: vi.fn(),
    setState: vi.fn(),
    toggleMode: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => mocks.logger,
}));

vi.mock('../stores/WindStore', () => ({
    WindStore: {
        getState: () => mocks.state.current,
        setGrid: mocks.setGrid,
        setLoading: mocks.setLoading,
        setError: mocks.setError,
        setState: mocks.setState,
        toggleMode: mocks.toggleMode,
    },
}));

vi.mock('../services/weather/OpenMeteoWindFetcher', () => ({
    fetchModelWindGrid: mocks.fetchModelWindGrid,
}));

vi.mock('../services/weather/windFieldTransforms', () => ({
    applyGustField: (grid: unknown) => grid,
}));

vi.mock('../services/weather/windField', () => ({
    fetchWindGrid: mocks.fetchWindGrid,
    fetchGlobalWindField: mocks.fetchGlobalWindField,
}));

vi.mock('../services/weather/GribWindParser', () => ({
    loadLocalWindFile: mocks.loadLocalWindFile,
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: () => false,
        baseUrl: '',
    },
}));

vi.mock('../utils/deadline', () => ({
    withDeadline: <T>(promise: Promise<T>) => promise,
}));

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function grid(id: string) {
    return {
        id,
        u: [new Float32Array(4)],
        v: [new Float32Array(4)],
        speed: [new Float32Array(4)],
        width: 2,
        height: 2,
        lats: [-28, -27],
        lons: [152, 153],
        north: -27,
        south: -28,
        west: 152,
        east: 153,
        totalHours: 1,
    };
}

function makeMap() {
    let bounds = {
        north: -20,
        south: -35,
        west: 145,
        east: 160,
    };
    const on = vi.fn();
    const off = vi.fn();
    const map = {
        getBounds: () => ({
            getNorth: () => bounds.north,
            getSouth: () => bounds.south,
            getWest: () => bounds.west,
            getEast: () => bounds.east,
        }),
        getZoom: () => 5,
        on,
        off,
    };
    const setBounds = (next: typeof bounds) => {
        bounds = next;
    };
    return { map, on, off, setBounds };
}

type WindController = (typeof import('../services/weather/WindDataController'))['WindDataController'];

let controller: WindController;

beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.state.current = {
        isGlobalMode: true,
        model: 'ecmwf',
        field: 'wind',
        grid: null,
        loading: false,
        error: null,
        localGribPath: null,
        hour: 0,
        totalHours: 0,
    };
    mocks.setGrid.mockImplementation((nextGrid: unknown) => {
        mocks.state.current = { ...mocks.state.current, grid: nextGrid, loading: false, error: null };
    });
    mocks.setLoading.mockImplementation((loading: boolean) => {
        mocks.state.current = { ...mocks.state.current, loading };
    });
    mocks.setError.mockImplementation((error: string) => {
        mocks.state.current = { ...mocks.state.current, error, loading: false };
    });
    mocks.setState.mockImplementation((partial: Record<string, unknown>) => {
        mocks.state.current = { ...mocks.state.current, ...partial } as typeof mocks.state.current;
    });
    mocks.toggleMode.mockImplementation(() => {
        mocks.state.current = {
            ...mocks.state.current,
            isGlobalMode: !mocks.state.current.isGlobalMode,
            grid: null,
            loading: false,
            error: null,
            hour: 0,
            totalHours: 0,
        };
    });
    controller = (await import('../services/weather/WindDataController')).WindDataController;
});

describe('WindDataController request generation', () => {
    it('publishes only the latest model when requests resolve out of order', async () => {
        const first = deferred<ReturnType<typeof grid> | null>();
        const second = deferred<ReturnType<typeof grid> | null>();
        mocks.fetchModelWindGrid.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const { map, on } = makeMap();

        const ecmwfActivation = controller.activate(map as never);
        await vi.waitFor(() => expect(mocks.fetchModelWindGrid).toHaveBeenCalledTimes(1));

        mocks.state.current = { ...mocks.state.current, model: 'icon', grid: null, loading: true };
        const iconActivation = controller.activate(map as never);
        await vi.waitFor(() => expect(mocks.fetchModelWindGrid).toHaveBeenCalledTimes(2));

        const iconGrid = grid('icon');
        second.resolve(iconGrid);
        await iconActivation;

        const ecmwfGrid = grid('ecmwf');
        first.resolve(ecmwfGrid);
        await ecmwfActivation;

        expect(mocks.setGrid).toHaveBeenCalledTimes(1);
        expect(mocks.setGrid).toHaveBeenCalledWith(iconGrid);
        expect(mocks.setGrid).not.toHaveBeenCalledWith(ecmwfGrid);
        expect(mocks.setError).not.toHaveBeenCalled();
        expect(on).toHaveBeenCalledTimes(2);
        expect(on).toHaveBeenCalledWith('moveend', expect.any(Function));
        expect(map.off).toHaveBeenCalledWith('moveend', on.mock.calls[0][1]);
    });

    it('ignores an obsolete field request failure without overwriting the current field', async () => {
        const sustained = deferred<ReturnType<typeof grid> | null>();
        const gust = deferred<ReturnType<typeof grid> | null>();
        mocks.fetchModelWindGrid.mockReturnValueOnce(sustained.promise).mockReturnValueOnce(gust.promise);
        const { map } = makeMap();

        const sustainedActivation = controller.activate(map as never);
        await vi.waitFor(() => expect(mocks.fetchModelWindGrid).toHaveBeenCalledTimes(1));

        mocks.state.current = { ...mocks.state.current, field: 'gust', grid: null, loading: true };
        const gustActivation = controller.activate(map as never);
        await vi.waitFor(() => expect(mocks.fetchModelWindGrid).toHaveBeenCalledTimes(2));

        sustained.reject(new Error('obsolete sustained-wind failure'));
        await sustainedActivation;

        const gustGrid = grid('gust');
        gust.resolve(gustGrid);
        await gustActivation;

        expect(mocks.setError).not.toHaveBeenCalled();
        expect(mocks.logger.error).not.toHaveBeenCalled();
        expect(mocks.setGrid).toHaveBeenCalledTimes(1);
        expect(mocks.setGrid).toHaveBeenCalledWith(gustGrid);
    });

    it('invalidates an in-flight activation on deactivate and never re-registers its listener', async () => {
        const pending = deferred<ReturnType<typeof grid> | null>();
        mocks.fetchModelWindGrid.mockReturnValueOnce(pending.promise);
        const { map, on } = makeMap();

        const activation = controller.activate(map as never);
        await vi.waitFor(() => expect(mocks.fetchModelWindGrid).toHaveBeenCalledOnce());

        controller.deactivate(map as never);
        pending.resolve(grid('late'));
        await activation;

        expect(mocks.setGrid).not.toHaveBeenCalled();
        expect(mocks.setError).not.toHaveBeenCalled();
        expect(mocks.state.current.grid).toBeNull();
        expect(mocks.state.current.loading).toBe(false);
        expect(on).toHaveBeenCalledOnce();
        expect(map.off).toHaveBeenCalledWith('moveend', on.mock.calls[0][1]);
    });

    it('clears a retained grid before a real refresh, keeps it clear on failure, and clears on deactivate', async () => {
        const pending = deferred<ReturnType<typeof grid> | null>();
        mocks.fetchModelWindGrid.mockReturnValueOnce(pending.promise);
        const { map } = makeMap();
        const staleGrid = grid('stale');
        mocks.state.current = {
            ...mocks.state.current,
            grid: staleGrid,
            totalHours: staleGrid.totalHours,
        };

        const activation = controller.activate(map as never);
        await vi.waitFor(() => expect(mocks.fetchModelWindGrid).toHaveBeenCalledOnce());

        expect(mocks.state.current.grid).toBeNull();
        expect(mocks.state.current.totalHours).toBe(0);
        expect(mocks.state.current.loading).toBe(true);

        pending.resolve(null);
        await activation;

        expect(mocks.state.current.grid).toBeNull();
        expect(mocks.state.current.loading).toBe(false);
        expect(mocks.state.current.error).toMatch(/No ECMWF wind data/);

        mocks.state.current = {
            ...mocks.state.current,
            grid: grid('newer'),
            totalHours: 1,
            loading: false,
            error: null,
        };
        controller.deactivate(map as never);
        expect(mocks.state.current).toMatchObject({
            grid: null,
            totalHours: 0,
            hour: 0,
            loading: false,
            error: null,
        });
    });

    it('routes local activation through the downloaded GRIB without registering a viewport listener', async () => {
        const localGrid = grid('local');
        mocks.state.current = {
            ...mocks.state.current,
            isGlobalMode: false,
            localGribPath: '/downloads/passage.wind.bin',
            grid: grid('stale-online'),
            totalHours: 1,
        };
        mocks.loadLocalWindFile.mockResolvedValueOnce(localGrid);
        const { map, on } = makeMap();

        await controller.activate(map as never);

        expect(mocks.loadLocalWindFile).toHaveBeenCalledWith('/downloads/passage.wind.bin');
        expect(mocks.fetchModelWindGrid).not.toHaveBeenCalled();
        expect(mocks.setGrid).toHaveBeenCalledWith(localGrid);
        expect(on).not.toHaveBeenCalled();
    });

    it('switches from online to local mode and reloads through the offline pipeline', async () => {
        const localGrid = grid('switched-local');
        mocks.state.current = {
            ...mocks.state.current,
            localGribPath: '/downloads/switched.wind.bin',
        };
        mocks.loadLocalWindFile.mockResolvedValueOnce(localGrid);
        const { map, on } = makeMap();

        await controller.switchMode(map as never);

        expect(mocks.toggleMode).toHaveBeenCalledOnce();
        expect(mocks.state.current.isGlobalMode).toBe(false);
        expect(mocks.loadLocalWindFile).toHaveBeenCalledWith('/downloads/switched.wind.bin');
        expect(mocks.fetchModelWindGrid).not.toHaveBeenCalled();
        expect(mocks.setGrid).toHaveBeenCalledWith(localGrid);
        expect(on).not.toHaveBeenCalled();
    });

    it('keeps the viewport listener live while the initial request is pending', async () => {
        vi.useFakeTimers();
        try {
            const initial = deferred<ReturnType<typeof grid> | null>();
            const movedGrid = grid('moved-viewport');
            mocks.fetchModelWindGrid.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(movedGrid);
            const { map, on, setBounds } = makeMap();

            const activation = controller.activate(map as never);
            await vi.waitFor(() => expect(mocks.fetchModelWindGrid).toHaveBeenCalledOnce());
            expect(on).toHaveBeenCalledOnce();

            setBounds({ north: 0, south: -10, west: 100, east: 110 });
            const moveEnd = on.mock.calls[0][1] as () => void;
            moveEnd();
            await vi.advanceTimersByTimeAsync(800);
            await vi.waitFor(() => expect(mocks.fetchModelWindGrid).toHaveBeenCalledTimes(2));

            expect(mocks.fetchModelWindGrid.mock.calls[1][1]).toMatchObject({
                north: 3,
                south: -13,
                west: 97,
                east: 113,
            });

            initial.resolve(grid('abandoned-viewport'));
            await activation;
            await vi.waitFor(() => expect(mocks.setGrid).toHaveBeenCalledWith(movedGrid));

            expect(mocks.setGrid).toHaveBeenCalledTimes(1);
            expect(mocks.setGrid).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'abandoned-viewport' }));
        } finally {
            vi.useRealTimers();
        }
    });
});
