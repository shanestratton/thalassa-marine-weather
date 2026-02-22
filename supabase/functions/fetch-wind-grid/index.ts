// deno-lint-ignore-file
/* eslint-disable @typescript-eslint/no-namespace */
declare const Deno: { serve: (handler: (req: Request) => Promise<Response> | Response) => void };

/**
 * fetch-wind-grid — NOAA GFS GRIB2 CORS Proxy
 *
 * Accepts a bounding box via POST, builds a NOAA NOMADS GFS GRIB Filter URL
 * for 10m U/V wind components, fetches the raw GRIB2 binary, and proxies it
 * back to the client with CORS headers.
 *
 * Single upstream request — no per-cell loops, no rate limits.
 *
 * Request: POST with JSON body:
 *   { north, south, east, west }
 *
 * Response: application/octet-stream (raw GRIB2 binary).
 *
 * Client must decode the GRIB2 response (e.g. using grib2-simple or a
 * custom DataView decoder).
 */



// ── CORS ──────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

// ── GFS cycle logic ───────────────────────────────────────────

/**
 * Calculate the latest available GFS run.
 * GFS publishes 4×/day at 00z, 06z, 12z, 18z.
 * Data becomes available ~4.5h after cycle time,
 * so we pick the most recent cycle that is at least 5h old.
 */
function getLatestGfsCycle(): { date: string; cycle: string } {
    const now = new Date();
    const utcHour = now.getUTCHours();

    // Available cycles in reverse order
    const cycles = [18, 12, 6, 0];
    let selectedCycle = 0;

    for (const c of cycles) {
        // Cycle is available if current UTC hour is at least cycle + 5
        if (utcHour >= c + 5) {
            selectedCycle = c;
            break;
        }
    }

    // If no cycle from today is ready yet (utcHour < 5), use yesterday's 18z
    let cycleDate = now;
    if (utcHour < 5) {
        selectedCycle = 18;
        cycleDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }

    const yyyy = cycleDate.getUTCFullYear();
    const mm = String(cycleDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(cycleDate.getUTCDate()).padStart(2, "0");

    return {
        date: `${yyyy}${mm}${dd}`,
        cycle: String(selectedCycle).padStart(2, "0"),
    };
}

// ── Longitude conversion ──────────────────────────────────────

/** Convert -180..180 longitude to NOAA's 0..360 format. */
function toNoaaLon(lon: number): number {
    // -180 should map to 0, not 360 (avoids leftlon=rightlon=180 for global requests)
    if (lon <= -180) return 0;
    return lon < 0 ? lon + 360 : lon;
}

// ── Resolution selection ──────────────────────────────────────

/** Pick the GFS grid resolution based on requested area size. */
function selectResolution(north: number, south: number, east: number, west: number): {
    filter: string;
    file: string;
    label: string;
} {
    const latSpan = Math.abs(north - south);
    let lonSpan = east - west;
    if (lonSpan <= 0) lonSpan += 360; // handle antimeridian wrap
    const areaDeg2 = latSpan * lonSpan;

    if (areaDeg2 > 10_000) {
        // >100°×100° → 1.0° grid (~65K points max)
        return { filter: "filter_gfs_1p00.pl", file: "pgrb2.1p00.f000", label: "1.00°" };
    }
    if (areaDeg2 > 2_500) {
        // >50°×50° → 0.50° grid (~65K points max)
        return { filter: "filter_gfs_0p50.pl", file: "pgrb2full.0p50.f000", label: "0.50°" };
    }
    // Small areas → full 0.25° resolution
    return { filter: "filter_gfs_0p25.pl", file: "pgrb2.0p25.f000", label: "0.25°" };
}

// ── Types ─────────────────────────────────────────────────────

interface WindRequest {
    north: number;
    south: number;
    east: number;
    west: number;
}

// ── Main handler ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return corsResponse(null, 204);
    }

    if (req.method !== "POST") {
        return corsResponse(
            JSON.stringify({ error: "POST required" }),
            405,
            { "Content-Type": "application/json" },
        );
    }

    try {
        const body: WindRequest = await req.json();
        const { north, south, east, west } = body;

        // Validate
        if (
            typeof north !== "number" || typeof south !== "number" ||
            typeof east !== "number" || typeof west !== "number"
        ) {
            return corsResponse(
                JSON.stringify({ error: "Missing bounds (north, south, east, west)" }),
                400,
                { "Content-Type": "application/json" },
            );
        }

        // Convert longitudes to 0-360 for NOAA
        const lonSpan = east - west;
        let leftLon: number;
        let rightLon: number;

        if (lonSpan >= 360) {
            // Full globe request — NOAA needs 0..360
            leftLon = 0;
            rightLon = 360;
        } else {
            leftLon = toNoaaLon(west);
            rightLon = toNoaaLon(east);
            // Handle antimeridian wrap: ensure rightlon > leftlon
            if (rightLon <= leftLon) rightLon += 360;
        }

        // Get latest GFS cycle
        const { date, cycle } = getLatestGfsCycle();

        // Auto-select resolution based on area
        const res = selectResolution(north, south, east, west);

        // Build NOMADS GRIB Filter URL — single request for the entire subregion
        const params = new URLSearchParams({
            dir: `/gfs.${date}/${cycle}/atmos`,
            file: `gfs.t${cycle}z.${res.file}`,
            var_UGRD: "on",
            var_VGRD: "on",
            lev_10_m_above_ground: "on",
            subregion: "",
            leftlon: leftLon.toFixed(2),
            rightlon: rightLon.toFixed(2),
            toplat: north.toFixed(2),
            bottomlat: south.toFixed(2),
        });

        const noaaUrl = `https://nomads.ncep.noaa.gov/cgi-bin/${res.filter}?${params.toString()}`;

        console.log(`[fetch-wind-grid] GFS ${date}/${cycle}z @ ${res.label} → ${noaaUrl}`);

        // Fetch GRIB2 from NOAA
        const upstream = await fetch(noaaUrl);

        if (!upstream.ok) {
            const errText = await upstream.text();
            console.error(`[fetch-wind-grid] NOAA error ${upstream.status}: ${errText}`);
            return corsResponse(
                JSON.stringify({
                    error: `NOAA NOMADS returned ${upstream.status}`,
                    detail: errText.substring(0, 500),
                    url: noaaUrl,
                }),
                502,
                { "Content-Type": "application/json" },
            );
        }

        // Stream the raw GRIB2 binary directly to the client
        const gribData = await upstream.arrayBuffer();

        // Guard: NOAA sometimes returns HTML error pages instead of GRIB2
        if (gribData.byteLength < 200) {
            const text = new TextDecoder().decode(gribData);
            console.error(`[fetch-wind-grid] Suspiciously small response (${gribData.byteLength}B): ${text}`);
            return corsResponse(
                JSON.stringify({
                    error: "NOAA returned empty or invalid data",
                    detail: text.substring(0, 300),
                    url: noaaUrl,
                }),
                502,
                { "Content-Type": "application/json" },
            );
        }

        console.log(
            `[fetch-wind-grid] Proxied ${gribData.byteLength} bytes ` +
            `(GFS ${date}/${cycle}z @ ${res.label}, bounds=[${south},${north}]×[${west},${east}])`,
        );

        return corsResponse(new Uint8Array(gribData) as unknown as BodyInit, 200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(gribData.byteLength),
            "X-GFS-Date": date,
            "X-GFS-Cycle": `${cycle}z`,
            "X-Bounds": `${south},${north},${west},${east}`,
        });
    } catch (err) {
        console.error("[fetch-wind-grid] Error:", err);
        return corsResponse(
            JSON.stringify({ error: String(err) }),
            500,
            { "Content-Type": "application/json" },
        );
    }
});
