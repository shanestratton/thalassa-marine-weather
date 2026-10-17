/**
 * MBTilesService: an offline chart opens and its holes stay quiet (W1-FX).
 *
 * open() reads the chart file the way the WebView may read it.
 *
 * On iOS, Filesystem.getUri() answers file:///…/Library/Caches/…. A fetch of
 * that URL is not an HTTP request, so CapacitorHttp hands it to the WebView's
 * own fetch, and the app's CSP refuses it ("Refused to connect to file:///…
 * because it does not appear in the connect-src directive", WebKit,
 * 2026-10-08). Capacitor.convertFileSrc() turns it into the app's own origin
 * (capacitor://localhost/_capacitor_file_/…), which connect-src 'self'
 * already allows, and leaves a web path untouched. Paths are fictional.
 */
import { inflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({
    native: true,
    getUri: vi.fn(),
    stat: vi.fn(),
    initialize: vi.fn(),
    prepare: vi.fn(),
    tile: null as Uint8Array | null,
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => cap.native,
        // Capacitor's own native-bridge rule for file:// paths; identity on web.
        convertFileSrc: (path: string) =>
            cap.native && path.startsWith('file://')
                ? path.replace('file://', 'capacitor://localhost/_capacitor_file_')
                : path,
    },
}));
vi.mock('@capacitor/filesystem', () => ({
    Filesystem: { getUri: cap.getUri, stat: cap.stat },
    Directory: { Cache: 'CACHE' },
}));
vi.mock('sql.js', () => ({
    default: async () => {
        cap.initialize();
        return {
            Database: class {
                prepare(sql: string) {
                    cap.prepare(sql);
                    if (sql.includes('tile_data'))
                        return {
                            bind: () => undefined,
                            step: () => cap.tile !== null,
                            get: () => [cap.tile],
                            free: () => undefined,
                        };
                    return { step: () => false, getAsObject: () => ({}), free: () => undefined };
                }
                close() {}
            },
        };
    },
}));

function sqlitePage(): Uint8Array {
    const page = new Uint8Array(512);
    page.set(new TextEncoder().encode('SQLite format 3\0'));
    new DataView(page.buffer).setUint16(16, 512, false);
    return page;
}

const fetchSpy = vi.fn(async (_input: RequestInfo | URL) => new Response(sqlitePage(), { status: 200 }));

beforeEach(() => {
    vi.resetModules();
    fetchSpy.mockClear();
    cap.stat.mockResolvedValue({ size: 512, type: 'file' });
    cap.initialize.mockClear();
    cap.prepare.mockClear();
    cap.tile = null;
    vi.stubGlobal('fetch', fetchSpy);
});

describe('MBTiles whole-file resource ownership', () => {
    it('refuses an oversized file before a URI, fetch or SQLite initialization', async () => {
        cap.stat.mockResolvedValue({ size: 32 * 1024 * 1024 + 1, type: 'file' });
        cap.getUri.mockClear();
        const { MBTilesService } = await import('../services/MBTilesService');
        await expect(MBTilesService.open('too-large.mbtiles')).rejects.toThrow('32 MiB');
        expect(cap.getUri).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(cap.initialize).not.toHaveBeenCalled();
    });
    it('refuses path traversal before touching the filesystem', async () => {
        cap.stat.mockClear();
        const { MBTilesService } = await import('../services/MBTilesService');
        expect(() => MBTilesService.open('../other.mbtiles')).toThrow();
        expect(cap.stat).not.toHaveBeenCalled();
        expect(cap.initialize).not.toHaveBeenCalled();
    });
    it('retiring a chart during its read prevents a late database installation', async () => {
        let finish: ((response: Response) => void) | undefined;
        fetchSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        cap.getUri.mockResolvedValue({ uri: '/CACHE/chart_downloads/late.mbtiles' });
        const { MBTilesService } = await import('../services/MBTilesService');
        const pending = MBTilesService.open('late.mbtiles');
        await vi.waitFor(() => expect(finish).toBeDefined());
        MBTilesService.close('late.mbtiles');
        finish!(new Response(sqlitePage()));
        await expect(pending).rejects.toThrow('cancelled');
        expect(cap.initialize).not.toHaveBeenCalled();
        expect(MBTilesService.getOpenCharts()).toEqual([]);
    });
    it('closeAll fences queued opens as well as the active read', async () => {
        let finish: ((response: Response) => void) | undefined;
        fetchSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        cap.getUri.mockResolvedValue({ uri: '/CACHE/chart_downloads/first.mbtiles' });
        const { MBTilesService } = await import('../services/MBTilesService');
        const first = MBTilesService.open('first.mbtiles'),
            second = MBTilesService.open('second.mbtiles');
        await vi.waitFor(() => expect(finish).toBeDefined());
        MBTilesService.closeAll();
        finish!(new Response(sqlitePage()));
        await expect(first).rejects.toThrow('cancelled');
        await expect(second).rejects.toThrow('cancelled');
        expect(fetchSpy).toHaveBeenCalledOnce();
    });
    it('does not query invalid tile coordinates or hand an oversized tile to the decoder', async () => {
        await openChart('/CACHE/chart_downloads/fictional-harbour.mbtiles', false);
        const { MBTilesService } = await import('../services/MBTilesService');
        cap.prepare.mockClear();
        expect(MBTilesService.getTile('fictional-harbour.mbtiles', 3, 8, 0)).toBeNull();
        expect(cap.prepare).not.toHaveBeenCalled();
        cap.tile = new Uint8Array(1024 * 1024 + 1);
        expect(MBTilesService.getTileBlobUrl('fictional-harbour.mbtiles', 3, 0, 0)).toBeNull();
    });
    it('copies only a tile view and revokes its owned URL when that chart closes', async () => {
        await openChart('/CACHE/chart_downloads/fictional-harbour.mbtiles', false);
        const { MBTilesService, TRANSPARENT_TILE_DATA_URL } = await import('../services/MBTilesService');
        const png = new Uint8Array(Buffer.from(TRANSPARENT_TILE_DATA_URL.split(',')[1], 'base64'));
        const surrounding = new Uint8Array(png.length + 100);
        surrounding.set(png, 30);
        cap.tile = surrounding.subarray(30, 30 + png.length);
        const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-tile');
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        try {
            expect(MBTilesService.getTileBlobUrl('fictional-harbour.mbtiles', 3, 0, 0)).toBe('blob:owned-tile');
            expect(create.mock.calls[0][0].size).toBe(png.length);
            MBTilesService.close('fictional-harbour.mbtiles');
            expect(revoke).toHaveBeenCalledWith('blob:owned-tile');
        } finally {
            create.mockRestore();
            revoke.mockRestore();
        }
    });
});

async function openChart(uri: string, native: boolean) {
    cap.native = native;
    cap.getUri.mockResolvedValue({ uri });
    const { MBTilesService } = await import('../services/MBTilesService');
    await MBTilesService.open('fictional-harbour.mbtiles');
    return fetchSpy.mock.calls.map((c) => String(c[0]));
}

describe('MBTilesService.open reads the chart file same-origin', () => {
    it('on iOS, fetches the capacitor:// file URL, never file://', async () => {
        const urls = await openChart(
            'file:///var/mobile/Containers/Data/Application/FICTIONAL/Library/Caches/chart_downloads/fictional-harbour.mbtiles',
            true,
        );
        expect(urls).toEqual([
            'capacitor://localhost/_capacitor_file_/var/mobile/Containers/Data/Application/FICTIONAL/Library/Caches/chart_downloads/fictional-harbour.mbtiles',
        ]);
        expect(urls.some((u) => u.startsWith('file:'))).toBe(false);
    });

    it('on the web, fetches the Filesystem path unchanged', async () => {
        const urls = await openChart('/CACHE/chart_downloads/fictional-harbour.mbtiles', false);
        expect(urls).toEqual(['/CACHE/chart_downloads/fictional-harbour.mbtiles']);
    });
});

describe('the missing-tile fallback is a real transparent PNG', () => {
    // The old inline data URL was 153 base64 characters with a bad IDAT CRC,
    // and both engines refused to fetch it, so every hole in a chart raised a
    // map error. Decode it strictly, the way a browser does.
    function crc32(buf: Uint8Array): number {
        let c = ~0;
        for (const b of buf) {
            c ^= b;
            for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        }
        return ~c >>> 0;
    }

    it('is strict base64 whose every chunk CRC checks, 1×1 RGBA, fully transparent', async () => {
        const { TRANSPARENT_TILE_DATA_URL } = await import('../services/MBTilesService');
        const prefix = 'data:image/png;base64,';
        expect(TRANSPARENT_TILE_DATA_URL.startsWith(prefix)).toBe(true);
        const b64 = TRANSPARENT_TILE_DATA_URL.slice(prefix.length);
        expect(b64.length % 4).toBe(0);
        expect(b64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        const png = Buffer.from(b64, 'base64');
        expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

        const chunks: Record<string, Buffer> = {};
        for (let at = 8; at < png.length; ) {
            const len = png.readUInt32BE(at);
            const type = png.subarray(at + 4, at + 8).toString('ascii');
            const body = png.subarray(at + 8, at + 8 + len);
            expect(png.readUInt32BE(at + 8 + len), `${type} CRC`).toBe(crc32(png.subarray(at + 4, at + 8 + len)));
            chunks[type] = body;
            at += 12 + len;
        }
        expect(Object.keys(chunks)).toEqual(['IHDR', 'IDAT', 'IEND']);
        const ihdr = chunks.IHDR;
        expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9]]).toEqual([1, 1, 8, 6]);
        // One scanline: filter byte, then R G B A — alpha 0.
        expect([...inflateSync(chunks.IDAT)]).toEqual([0, 0, 0, 0, 0]);
    });

    it('is the tile useMapInit answers a missing mbtiles.local square with', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync('components/map/useMapInit.ts', 'utf8');
        expect(src).toContain('return { url: TRANSPARENT_TILE_DATA_URL };');
        expect(src).not.toMatch(/data:image\/png;base64,/);
    });
});
