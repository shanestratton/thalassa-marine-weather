// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-rainbow — Rainbow.ai Tile API Proxy
 *
 * Three modes:
 *   1. Snapshot:   GET /proxy-rainbow?action=snapshot
 *                  → Fetches current snapshot ID from Rainbow.ai
 *   2. Tile:      GET /proxy-rainbow?action=tile&snapshot=<id>&forecast=<secs>&z=<z>&x=<x>&y=<y>&color=<color>
 *                  → Proxies tile PNG with token injected server-side
 *   3. Point:     GET /proxy-rainbow?action=point&lat=<lat>&lon=<lon>
 *                  → Samples precipitation at a point across 14 forecast steps (0-240 min)
 *                  → Decodes PNG tiles server-side, returns JSON {forecastMinutes, intensity}[]
 *
 * Required Supabase Secret:
 *   RAINBOW_API_KEY
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const RAINBOW_BASE = 'https://api.rainbow.ai/tiles/v1';

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'GET required' }), {
            status: 405,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const key = Deno.env.get('RAINBOW_API_KEY');
    if (!key) {
        return new Response(JSON.stringify({ error: 'RAINBOW_API_KEY not configured' }), {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    try {
        // ═══ ACTION: SNAPSHOT ═══
        if (action === 'snapshot') {
            const res = await fetch(`${RAINBOW_BASE}/snapshot?token=${key}`);
            const data = await res.json();
            return new Response(JSON.stringify(data), {
                status: res.status,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }

        // ═══ ACTION: TILE ═══
        if (action === 'tile') {
            const snapshot = url.searchParams.get('snapshot');
            const forecast = url.searchParams.get('forecast');
            const z = url.searchParams.get('z');
            const x = url.searchParams.get('x');
            const y = url.searchParams.get('y');
            const color = url.searchParams.get('color') || 'dbz_u8';

            if (!snapshot || !forecast || !z || !x || !y) {
                return new Response(JSON.stringify({ error: 'Missing tile params' }), {
                    status: 400,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }

            const tileUrl = `${RAINBOW_BASE}/precip/${snapshot}/${forecast}/${z}/${x}/${y}?token=${key}&color=${color}`;
            const res = await fetch(tileUrl);

            if (!res.ok) {
                return new Response(JSON.stringify({ error: `Rainbow API: ${res.status}` }), {
                    status: res.status,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }

            const body = await res.arrayBuffer();
            const contentType = res.headers.get('Content-Type') || 'image/png';
            return new Response(body, {
                status: 200,
                headers: {
                    ...CORS,
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=300',
                },
            });
        }

        // ═══ ACTION: POINT ═══
        if (action === 'point') {
            const lat = parseFloat(url.searchParams.get('lat') || '0');
            const lon = parseFloat(url.searchParams.get('lon') || '0');

            if (lat === 0 && lon === 0) {
                return new Response(JSON.stringify({ error: 'lat and lon required' }), {
                    status: 400,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }

            // 1. Get latest snapshot
            const snapRes = await fetch(`${RAINBOW_BASE}/snapshot?token=${key}`);
            if (!snapRes.ok) {
                return new Response(JSON.stringify({ error: `Snapshot failed: ${snapRes.status}` }), {
                    status: 502,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }
            const snapData = await snapRes.json();
            const snapshot = snapData.snapshot;
            if (!snapshot) {
                return new Response(JSON.stringify({ error: 'No snapshot available' }), {
                    status: 502,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }

            // 2. Calculate tile coordinates (zoom 10 — ~40km per tile, ~160m per pixel)
            const zoom = 10;
            const n = Math.pow(2, zoom);
            const tileX = Math.floor(((lon + 180) / 360) * n);
            const latRad = (lat * Math.PI) / 180;
            const tileY = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
            const pixelX = Math.min(255, Math.max(0, Math.floor((((lon + 180) / 360) * n - tileX) * 256)));
            const pixelY = Math.min(
                255,
                Math.max(
                    0,
                    Math.floor(
                        (((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n - tileY) * 256,
                    ),
                ),
            );

            // 3. Fetch tiles for each forecast step, decode PNG, extract pixel
            const FORECAST_MINUTES = [0, 10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 180, 210, 240];
            const results: { forecastMinutes: number; intensity: number }[] = [];

            // Process in batches of 4 to limit concurrent API requests
            for (let batch = 0; batch < FORECAST_MINUTES.length; batch += 4) {
                const batchMins = FORECAST_MINUTES.slice(batch, batch + 4);
                const batchResults = await Promise.allSettled(
                    batchMins.map(async (min) => {
                        const secs = min * 60;
                        const tileUrl =
                            `${RAINBOW_BASE}/precip/${snapshot}/${secs}/${zoom}/${tileX}/${tileY}` +
                            `?token=${key}&color=dbz_u8`;

                        const tileRes = await fetch(tileUrl);
                        if (!tileRes.ok) throw new Error(`Tile HTTP ${tileRes.status}`);

                        const buf = new Uint8Array(await tileRes.arrayBuffer());
                        const pixelValue = await decodePngPixel(buf, 256, pixelX, pixelY);
                        return { forecastMinutes: min, intensity: dbzToMmHr(pixelValue) };
                    }),
                );

                for (let i = 0; i < batchResults.length; i++) {
                    const result = batchResults[i];
                    const min = batchMins[i];
                    if (result.status === 'fulfilled') {
                        results.push(result.value);
                    } else {
                        console.warn(`[proxy-rainbow] Tile ${min}m failed:`, result.reason);
                        results.push({ forecastMinutes: min, intensity: 0 });
                    }
                }
            }

            return new Response(
                JSON.stringify({
                    snapshot,
                    lat,
                    lon,
                    data: results.sort((a, b) => a.forecastMinutes - b.forecastMinutes),
                }),
                {
                    status: 200,
                    headers: {
                        ...CORS,
                        'Content-Type': 'application/json',
                        'Cache-Control': 'public, max-age=300',
                    },
                },
            );
        }

        return new Response(
            JSON.stringify({ error: 'Unknown action. Use action=snapshot, action=tile, or action=point' }),
            { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
    } catch (e) {
        console.error('[proxy-rainbow] Error:', e);
        return new Response(JSON.stringify({ error: 'Internal proxy error' }), {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }
});

// ════════════════════════════════════════════════════════════════
// PNG PIXEL EXTRACTION — zero external deps, uses Web APIs only
// ════════════════════════════════════════════════════════════════

/** Read uint32 big-endian */
function readU32(buf: Uint8Array, off: number): number {
    return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

/** Paeth predictor (PNG filter type 4) */
function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/**
 * Extract a single pixel's red/gray channel from a PNG buffer.
 * Parses IHDR + IDAT chunks, inflates via DecompressionStream,
 * de-filters the target row, returns the pixel value.
 */
async function decodePngPixel(png: Uint8Array, width: number, px: number, py: number): Promise<number> {
    try {
        // ── Parse PNG chunks ──
        let offset = 8; // Skip 8-byte PNG signature
        let colorType = 0;
        const idatChunks: Uint8Array[] = [];

        while (offset < png.length) {
            const length = readU32(png, offset);
            const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);

            if (type === 'IHDR') {
                colorType = png[offset + 17]; // 0=gray, 2=RGB, 4=gray+A, 6=RGBA
            } else if (type === 'IDAT') {
                idatChunks.push(png.slice(offset + 8, offset + 8 + length));
            } else if (type === 'IEND') {
                break;
            }

            offset += 12 + length; // length(4) + type(4) + data(length) + CRC(4)
        }

        if (idatChunks.length === 0) return 0;

        // ── Concatenate IDAT chunks (zlib-wrapped deflate) ──
        const totalLen = idatChunks.reduce((s, c) => s + c.length, 0);
        const compressed = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of idatChunks) {
            compressed.set(chunk, pos);
            pos += chunk.length;
        }

        // ── Inflate using DecompressionStream (Web API, available in Deno Deploy) ──
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(compressed).catch(() => {});
        writer.close().catch(() => {});

        const reader = ds.readable.getReader();
        const inflatedChunks: Uint8Array[] = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) inflatedChunks.push(value);
        }

        const inflatedLen = inflatedChunks.reduce((s, c) => s + c.length, 0);
        const raw = new Uint8Array(inflatedLen);
        let p = 0;
        for (const c of inflatedChunks) {
            raw.set(c, p);
            p += c.length;
        }

        // ── De-filter the target row and the row above (needed for Up/Average/Paeth) ──
        const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
        const rowBytes = width * bpp; // pixel data per row (no filter byte)
        const stride = rowBytes + 1; // +1 for filter byte

        // De-filter row py (and py-1 if needed for Up/Avg/Paeth)
        let prevRow: Uint8Array | null = null;
        let targetRow: Uint8Array | null = null;

        for (let y = Math.max(0, py - 1); y <= py; y++) {
            const rowStart = y * stride;
            if (rowStart >= raw.length) break;

            const filterByte = raw[rowStart];
            const scanline = raw.slice(rowStart + 1, rowStart + 1 + rowBytes);
            const decoded = new Uint8Array(rowBytes);

            for (let i = 0; i < rowBytes; i++) {
                const a = i >= bpp ? decoded[i - bpp] : 0; // left
                const b = prevRow ? prevRow[i] : 0; // above
                const c = prevRow && i >= bpp ? prevRow[i - bpp] : 0; // upper-left
                const x = scanline[i] ?? 0;

                switch (filterByte) {
                    case 0:
                        decoded[i] = x;
                        break; // None
                    case 1:
                        decoded[i] = (x + a) & 0xff;
                        break; // Sub
                    case 2:
                        decoded[i] = (x + b) & 0xff;
                        break; // Up
                    case 3:
                        decoded[i] = (x + Math.floor((a + b) / 2)) & 0xff;
                        break; // Average
                    case 4:
                        decoded[i] = (x + paeth(a, b, c)) & 0xff;
                        break; // Paeth
                    default:
                        decoded[i] = x;
                }
            }

            if (y === py) targetRow = decoded;
            prevRow = decoded;
        }

        if (!targetRow) return 0;
        return targetRow[px * bpp] ?? 0; // First channel (red or gray)
    } catch (err) {
        console.error('[proxy-rainbow] PNG decode error:', err);
        return 0;
    }
}

/**
 * Convert dBZ u8 pixel → mm/hr using Marshall-Palmer Z-R relationship.
 * dbz_u8 encoding: pixel 0-11 = no rain, 12-83 = light→heavy precip.
 * Z = 200 * R^1.6, so R = (Z/200)^(1/1.6)
 */
function dbzToMmHr(pixel: number): number {
    if (pixel < 12) return 0;
    const dBZ = 5 + ((pixel - 12) * 50) / 71; // Map 12-83 → 5-55 dBZ
    const Z = Math.pow(10, dBZ / 10);
    const R = Math.pow(Z / 200, 1 / 1.6);
    return Math.round(R * 100) / 100;
}
