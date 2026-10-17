/**
 * No Esri, no knackwx (129-09b). Cyclone tracks and cones came from Esri's
 * Living Atlas item "Active Hurricanes, Cyclones and Typhoons" (Esri Master
 * License Agreement: commercial use of Living Atlas content needs a licence)
 * and the storm list from knackwx (no terms, no uptime statement). Both are
 * gone: the warning centres are read direct (NOAA, JTWC, NCEP). This guard
 * fails if either comes back in any file git tracks (the app, its services,
 * the edge functions, the Pi, the web app's CSP and every HTML page). tests/
 * and docs/ are not scanned: fixtures, test comments and notes may name them.
 *
 * Esri's World Imagery base map (server.arcgisonline.com) is a separate Esri
 * service and a separate question; it is not what this guards.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The hosts: knackwx's, and Esri's hosted feature services (services*.arcgis.com), with the item's own names. */
const BANNED = [
    /knackwx\.com/i,
    /services\d*\.arcgis\.com/i,
    /Active_Hurricanes/i,
    /248e7b5827a34b248647afb012c58787/i,
    /\*\.arcgis\.com/i,
];

/**
 * Every file git tracks, outside tests/ and docs/ (fixtures and notes may name
 * the hosts), node_modules and dist: the app's whole tree (api/, contexts/,
 * modules/, managers/, the root entry files, cloudflare-worker/, every HTML
 * page), never a hand-picked list that a new folder slips past. Binary files
 * (a NUL byte) are skipped.
 */
function trackedTextFiles(): string[] {
    const listed = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0')
        .filter(Boolean);
    return listed.filter((path) => {
        const parts = path.split('/');
        if (parts[0] === 'tests' || parts.includes('docs')) return false;
        if (parts.includes('node_modules') || parts.includes('dist')) return false;
        return existsSync(path) && statSync(path).isFile();
    });
}

describe('no Esri cyclone feed and no knackwx, anywhere the product can reach', () => {
    const scanned = trackedTextFiles();

    it('scans every tracked file of the app, its services, the edge functions and the Pi', () => {
        expect(scanned.length).toBeGreaterThan(2000);
        for (const must of [
            'App.tsx',
            'ApplicationShell.tsx',
            'index.tsx',
            'viewRegistry.tsx',
            'utils.ts',
            'middleware.ts',
            'beta.html',
            'ocean.html',
            'services/weather/CycloneTrackingService.ts',
            'supabase/functions/cyclone-feed/index.ts',
            'supabase/functions/cyclone-watch/index.ts',
            'supabase/functions/_shared/cyclone/sources.ts',
            'pi-cache/src/routes/misc.ts',
            'pi-cache/src/scheduler.ts',
            'index.html',
            'vercel.json',
        ]) {
            expect(scanned).toContain(must);
        }
        for (const dir of ['api/', 'contexts/', 'modules/', 'managers/', 'cloudflare-worker/']) {
            expect(scanned.some((f) => f.startsWith(dir))).toBe(true);
        }
        expect(scanned.some((f) => f.startsWith('tests/') || f.includes('node_modules/'))).toBe(false);
    });

    it('names neither host in any of them', () => {
        const hits: string[] = [];
        for (const file of scanned) {
            const bytes = readFileSync(file);
            if (bytes.includes(0)) continue;
            const text = bytes.toString('utf8');
            for (const re of BANNED) {
                const m = re.exec(text);
                if (m) hits.push(`${file}: ${m[0]}`);
            }
        }
        expect(hits).toEqual([]);
    });

    it('the Esri parser is gone, and the feed reads the centres themselves', () => {
        expect(scanned).not.toContain('supabase/functions/_shared/cyclone/esri.ts');
        const sources = readFileSync('supabase/functions/_shared/cyclone/sources.ts', 'utf8');
        for (const host of [
            'https://www.nhc.noaa.gov/CurrentStorms.json',
            'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer',
            'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss',
            'https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/',
        ]) {
            expect(sources).toContain(host);
        }
    });
});
