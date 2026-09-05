import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

/**
 * EVERY call to the Pi must go through the pinned transport.
 *
 * This is the test that would have caught the 2026-08-07 outage. Moving the Pi
 * to TLS changed `piCache.baseUrl` from http to https, and its certificate is
 * self-signed and pinned — so any caller still using CapacitorHttp or plain
 * fetch stopped completing the handshake. The conversion was partial:
 * discovery, pairing and fetchVerifiedFromPi were moved, but checkHealth was
 * not.
 *
 * checkHealth is the gate isAvailable() depends on, which is the gate the ENC
 * sync depends on. So the Pi could never become reachable, nothing synced, and
 * the app reported "no verified ENC charts" while the Pi sat there serving 345
 * of them. Nothing logged an error loud enough to notice, because every layer
 * treated an unreachable Pi as a normal offline condition.
 *
 * A grep-shaped test is the right tool here: the failure mode is a call site
 * someone forgot, and no behavioural test covers a transport that silently
 * degrades to "Pi is offline".
 */
/**
 * A FIXED FILE LIST WAS THE WRONG SHAPE. This guard used to scan six files by
 * name — PiCacheService, EncImportService, DiaryRelayTransport,
 * OsmRouteOverlayService, ChartLockerService, isochroneEnhancer. All six were
 * clean, and stayed clean, because they were the six that had already been
 * fixed. A guard against "someone forgot a call site" cannot be a list of the
 * call sites someone remembered.
 *
 * On 2026-09-05 an audit found four live offenders, none of them on that list:
 *   services/weather/api/unified.ts    — plain fetch of unifiedWeatherUrl();
 *                                        the Pi's pre-fetched payload was
 *                                        never once read on iOS
 *   services/weather/api/marine.ts     — the Pi hop shared a plain-fetch
 *                                        helper with the Supabase hop, and
 *                                        logged the -1202 as "Pi marine miss"
 *   services/weather/WindDataController.ts \
 *   hooks/useVoyageForm.ts             — two hand-copies of the wind-grid
 *                                        request; only isochroneEnhancer's
 *                                        copy, the one ON the list, was
 *                                        migrated. Planning a passage aboard
 *                                        failed on the boat's own network.
 * plus two inside PiCacheService's own passthrough wrappers, which called the
 * UNPINNED piRequest while a sibling guard asserted that they must.
 *
 * So: walk the tree, and name the exemptions instead of the members.
 */
const SCAN_DIRS = ['services', 'components', 'hooks', 'stores', 'utils'];

/**
 * Files that may talk to a Pi host without the pinned transport, and why.
 * Adding one is a deliberate act — the reason must be a property of the HOST,
 * not a convenience.
 */
const ALLOWED = new Map<string, string>([
    [
        'services/PiProvisionService.ts',
        'post-install liveness probe: runs BEFORE any pairing exists, so there ' +
            'is no key to pin yet. A probe, never a data path.',
    ],
    [
        'services/anchorPiPush.ts',
        'targets a Tailscale MagicDNS host (*.ts.net) whose certificate is ' +
            'publicly valid. There is nothing to pin.',
    ],
    ['services/piTls.ts', 'IS the transport'],
    ['services/PiPairingService.ts', 'owns pairing, including the one unpinned /api/pair/info lane'],
]);

/** Anything that performs a request without being able to present a pin. */
const RAW_TRANSPORT = /CapacitorHttp\.|(?<![A-Za-z0-9_$])fetch\s*\(|new XMLHttpRequest|axios\./;

/**
 * How a Pi URL gets built. The old pattern knew only `piCache.baseUrl` and
 * friends, which is why unified.ts (piCache.unifiedWeatherUrl()) and a
 * `https://${host}:${PI_CACHE_PORT}` literal both slipped past it.
 */
const PI_URL_CONTEXT =
    /piCache\.baseUrl|piCacheBase|\$\{piBase\}|unifiedWeatherUrl\s*\(|passthroughUrl\s*\(|passthroughTileUrl\s*\(|leafletTileTemplate\s*\(|getRemoteBaseUrl\s*\(|PI_CACHE_PORT|:3001/;

/**
 * `${base}/api/` USED TO BE IN THAT PATTERN, and it was wrong: the Pi hosts
 * more than one service. services/voice/bosunVoice.ts and piTools.ts both
 * fetch `http://${piHost}:5000/api/health` — the Bosun web server, plain HTTP
 * on its own port, where a plain fetch is exactly right. Same host is not the
 * same service, and a guard that cannot tell them apart gets switched off.
 *
 * A line that names its own non-Pi host is likewise not a finding, however
 * close it sits to one that does — the two legs of a Pi-or-cloud fetch are
 * neighbours by design (services/weather/fetchWindGrid.ts).
 */
const NAMES_ANOTHER_HOST = /supabase|functions\/v1|https?:\/\/\$\{?[A-Za-z]/;

/** How far back a URL may be defined from the call that fetches it. */
const CONTEXT_LINES = 12;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
}

/** Strip comments so prose about CapacitorHttp doesn't read as a call. */
const codeOf = (relative: string): string =>
    read(relative)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

describe('Pi transport completeness', () => {
    it('never sends a Pi URL through CapacitorHttp or plain fetch', () => {
        const offenders: string[] = [];
        const files = SCAN_DIRS.flatMap((dir) => walk(dir)).filter((f) => !ALLOWED.has(f));

        for (const file of files) {
            const code = codeOf(file);
            const lines = code.split('\n');
            lines.forEach((line, index) => {
                if (!RAW_TRANSPORT.test(line)) return;
                // A raw transport is only a bug when the URL is the Pi's. Look
                // back for the Pi address being built — that is how every one
                // of these call sites gets its URL.
                if (NAMES_ANOTHER_HOST.test(line)) return;
                const context = lines.slice(Math.max(0, index - CONTEXT_LINES), index + 1).join('\n');
                if (PI_URL_CONTEXT.test(context)) {
                    offenders.push(`${file}:${index + 1} — ${line.trim().slice(0, 70)}`);
                }
            });
        }

        expect(
            offenders,
            `These fetch a Pi URL with a transport that cannot present its ` +
                `self-signed certificate — NSURLErrorDomain -1202 on every iOS ` +
                `device, usually swallowed as "the Pi is offline". Use ` +
                `pinnedPiRequest() from services/PiPairingService.ts, or add the ` +
                `file to ALLOWED above with a reason about the HOST. Offenders:\n  ` +
                offenders.join('\n  '),
        ).toEqual([]);
    });

    it('actually fires on a regression — a guard that cannot fail is decoration', () => {
        // The previous version of this guard passed for months while four live
        // offenders sat in the tree, so prove the detector rather than trust it.
        const regression = [
            'const url = `${piCache.baseUrl}/api/whatever`;',
            'const res = await fetch(url, { method: "POST" });',
        ];
        const context = regression.join('\n');
        expect(RAW_TRANSPORT.test(regression[1])).toBe(true);
        expect(NAMES_ANOTHER_HOST.test(regression[1])).toBe(false);
        expect(PI_URL_CONTEXT.test(context)).toBe(true);

        // And the shapes that slipped past the OLD pattern, one per offender.
        expect(PI_URL_CONTEXT.test('const piUrl = piCache.unifiedWeatherUrl(lat, lon, uid, false);')).toBe(true);
        expect(PI_URL_CONTEXT.test('const u = `https://${host}:${PI_CACHE_PORT}/health`;')).toBe(true);
        expect(RAW_TRANSPORT.test('const res = fetch(url, { headers }).then(')).toBe(true);
        expect(RAW_TRANSPORT.test('withDeadline(fetch(edgeUrl, { method: "POST" }),')).toBe(true);

        // ...without firing on the Bosun web server, which is plain HTTP by design.
        expect(PI_URL_CONTEXT.test('return `http://${piHost}:${BOSUN_WEB_PORT}`;')).toBe(false);
    });

    it('keeps checkHealth on the pinned transport — it gates everything else', () => {
        const service = codeOf('services/PiCacheService.ts');
        const checkHealth = service.slice(service.indexOf('private async checkHealth'));
        // Search from 1: the slice STARTS with 'private async', so indexOf
        // from 0 matches immediately and yields an empty body that trivially
        // passes a .not assertion.
        const nextMethod = checkHealth.indexOf('private async ', 1);
        const body = nextMethod > 0 ? checkHealth.slice(0, nextMethod) : checkHealth;
        expect(body).toContain('pinnedPiRequest');
        expect(body).not.toMatch(/CapacitorHttp\.|await fetch\(/);
    });

    it('routes the ENC listing through the pinned transport', () => {
        // listPiInstalledCharts is what the ENC sync reads to learn which
        // cells the Pi holds. Unpinned, it returns [] and the app concludes
        // there are no charts.
        const enc = codeOf('services/EncImportService.ts');
        expect(enc).toContain('/api/enc/installed');
        const listing = enc.slice(enc.indexOf('export async function listPiInstalledCharts'));
        expect(listing.slice(0, 600)).toContain('pinnedPiRequest');
    });

    it('never carries the diary relay token over an unpinned channel', () => {
        // Confidentiality of this token is the reason the boat LAN went to TLS.
        const diary = codeOf('services/DiaryRelayTransport.ts');
        const postToPi = diary.slice(diary.indexOf('async function postToPi'));
        const body = postToPi.slice(0, postToPi.indexOf('async function configurePiRelay'));
        expect(body).toContain('pinnedPiRequest');
        expect(body).not.toMatch(/CapacitorHttp\.|await fetch\(/);

        // /api/configure is the other token-bearing call. Anchor on the URL
        // TEMPLATE, not the bare path — the path also appears inside an error
        // message string, and matching that would test nothing.
        const config = codeOf('services/PiCacheService.ts');
        const callSite = config.indexOf('url: `${this.baseUrl}/api/configure`');
        expect(callSite).toBeGreaterThan(-1);
        expect(config.slice(callSite - 300, callSite + 300)).toContain('pinnedPiRequest');
    });

    it('keeps the binary wind grid on an arraybuffer response', () => {
        // Reading GRIB2 as text corrupts it into a decode failure that looks
        // like a bad forecast rather than a transport bug. PiTlsPlugin returns
        // `String(data:encoding:.utf8) ?? ""` for a text read — a SILENT empty
        // string with status 200.
        const grid = codeOf('services/weather/fetchWindGrid.ts');
        const piLeg = grid.slice(grid.indexOf('if (usePi)'), grid.indexOf('const cloudRes'));
        expect(piLeg).toContain('pinnedPiRequest');
        expect(piLeg).toContain("responseType: 'arraybuffer'");
        expect(piLeg).not.toContain("responseType: 'text'");
    });

    it('has exactly ONE wind-grid implementation, because three had two bugs', () => {
        // isochroneEnhancer, WindDataController and useVoyageForm each carried
        // a hand-copy of this request. One was migrated to the pinned
        // transport and two were not — and useVoyageForm's copy even carried a
        // comment saying it was the same logic as the one that got fixed.
        const callers = [
            'services/isochroneEnhancer.ts',
            'services/weather/WindDataController.ts',
            'hooks/useVoyageForm.ts',
        ];
        for (const file of callers) {
            const code = codeOf(file);
            expect(code, `${file} must use the shared wind-grid fetch`).toMatch(/fetchWindGrid(Buffer|OrNull)/);
            expect(code, `${file} must not rebuild the wind-grid URL itself`).not.toContain('/api/grib/wind-grid');
            expect(code, `${file} must not call the edge function directly`).not.toContain(
                'functions/v1/fetch-wind-grid',
            );
        }
    });
});
