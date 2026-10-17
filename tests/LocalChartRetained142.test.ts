import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
    initialize: vi.fn(),
    created: vi.fn(),
    closed: vi.fn(),
    ordinary: true,
    hidden: 0,
    rows: [
        { name: 'format', value: 'png' },
        { name: 'bounds', value: '-45,-22,-22.5,0' },
    ],
}));
vi.mock('sql.js', () => ({ default: () => mock.initialize() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: {}, Directory: { Cache: 'CACHE' } }));
const name = `retained-${'a'.repeat(32)}-00000000-0000-4000-8000-000000000001.mbtiles`;
function bytes() {
    const value = new Uint8Array(512);
    value.set(new TextEncoder().encode('SQLite format 3\0'));
    new DataView(value.buffer).setUint16(16, 512, false);
    return value;
}
function sql() {
    return {
        Database: class {
            constructor() {
                mock.created();
            }
            close() {
                mock.closed();
            }
            run() {}
            prepare(query: string) {
                let row = -1;
                const rows = query.includes('sqlite_master')
                    ? [{ type: mock.ordinary ? 'table' : 'view', rootpage: mock.ordinary ? 2 : 0 }]
                    : query.includes('table_xinfo')
                      ? (query.includes('metadata')
                            ? ['name', 'value']
                            : ['zoom_level', 'tile_column', 'tile_row', 'tile_data']
                        ).map((name) => ({ name, hidden: mock.hidden }))
                      : mock.rows;
                return {
                    bind: () => {},
                    step: () => ++row < rows.length,
                    getAsObject: () => rows[row],
                    free: () => {},
                };
            }
        },
    };
}
beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mock.ordinary = true;
    mock.hidden = 0;
    mock.rows = [
        { name: 'format', value: 'png' },
        { name: 'bounds', value: '-45,-22,-22.5,0' },
    ];
    mock.initialize.mockResolvedValue(sql());
});
afterEach(() => vi.useRealTimers());
it('does not initialize SQL for invalid retained input', async () => {
    const { MBTilesService } = await import('../services/MBTilesService');
    expect(() =>
        MBTilesService.openRetained({ fileName: name, name: 'Own', bytes: new Uint8Array(512), isCurrent: () => true }),
    ).toThrow();
    expect(mock.initialize).not.toHaveBeenCalled();
});
it('expires a stalled SQL load and never installs its late database', async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof sql>) => void;
    mock.initialize.mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const { MBTilesService } = await import('../services/MBTilesService');
    const pending = MBTilesService.openRetained({
        fileName: name,
        name: 'Own',
        bytes: bytes(),
        isCurrent: () => true,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15050);
    expect(await pending).toMatchObject({ message: 'Local chart opening timed out.' });
    finish(sql());
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.created).not.toHaveBeenCalled();
    expect(MBTilesService.getOpenCharts()).toEqual([]);
});
it('retires SQL on owner loss and an old proof cannot close a replacement reader', async () => {
    const { MBTilesService } = await import('../services/MBTilesService');
    let live = true;
    const first = () => live;
    await MBTilesService.openRetained({ fileName: name, name: 'Owner A', bytes: bytes(), isCurrent: first });
    live = false;
    expect(MBTilesService.getOpenCharts()).toEqual([]);
    expect(MBTilesService.getTile(name, 4, 6, 8)).toBeNull();
    expect(mock.closed).toHaveBeenCalledTimes(1);
    const second = () => true;
    await MBTilesService.openRetained({
        fileName: name,
        name: 'New owner A generation',
        bytes: bytes(),
        isCurrent: second,
    });
    MBTilesService.closeRetained(name, first);
    expect(MBTilesService.getOpenCharts()).toHaveLength(1);
    MBTilesService.closeRetained(name, second);
    expect(MBTilesService.getOpenCharts()).toEqual([]);
});
it.each(['pbf', '', 'png-overlong'])(
    'refuses unsupported original metadata %s and closes the database',
    async (format) => {
        mock.rows = [{ name: 'format', value: format }];
        const { MBTilesService } = await import('../services/MBTilesService');
        await expect(
            MBTilesService.openRetained({ fileName: name, name: 'Own', bytes: bytes(), isCurrent: () => true }),
        ).rejects.toThrow();
        expect(mock.closed).toHaveBeenCalledTimes(1);
        expect(MBTilesService.getOpenCharts()).toEqual([]);
    },
);
it.each(['view', 'generated'])('refuses %s SQL before reading chart metadata', async (kind) => {
    mock.ordinary = kind !== 'view';
    mock.hidden = kind === 'generated' ? 2 : 0;
    const { MBTilesService } = await import('../services/MBTilesService');
    await expect(
        MBTilesService.openRetained({ fileName: name, name: 'Own', bytes: bytes(), isCurrent: () => true }),
    ).rejects.toThrow(/views|hidden/);
    expect(mock.closed).toHaveBeenCalledTimes(1);
});
