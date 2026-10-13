/**
 * The cyclone feeds' readers (129-09, _shared/cyclone/sources.ts), run on
 * stubbed responses: NHC's a-decks are gzipped and their newest cycles are at
 * the end, so they are streamed through, not truncated; and a feed that does
 * not answer is null (unavailable), never an empty list of storms. The
 * warning centres' own feed (CurrentStorms.json, NOAA's MapServer, JTWC, the
 * TC vitals) is tested in CycloneFeed.test.ts.
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adeckLinesSince, fetchGfsAtcfunix, fetchNhcAdecks } from '../supabase/functions/_shared/cyclone/sources';
import { modelTracks, parseAdeck } from '../supabase/functions/_shared/cyclone/adeck';

const atlantic = readFileSync('tests/fixtures/cyclone/adeck-atlantic.dat', 'utf8');
const NOW = Date.parse('2026-10-13T18:00:00Z');

afterEach(() => vi.unstubAllGlobals());

describe('adeckLinesSince', () => {
    it('unzips a gzipped a-deck and keeps the cycles from the cut-off on', async () => {
        const text = await adeckLinesSince(new Response(gzipSync(atlantic)), '2026101300');
        const tracks = parseAdeck(text!);
        expect(tracks.find((t) => t.tech === 'EMX')).toBeUndefined();
        expect(tracks.find((t) => t.tech === 'AVNI')?.points).toHaveLength(7);
    });

    it('reads one that was already unzipped on the way', async () => {
        const text = await adeckLinesSince(new Response(atlantic), '2026101306');
        expect(
            parseAdeck(text!)
                .map((t) => t.tech)
                .sort(),
        ).toEqual(['AVNI', 'OFCL']);
    });
});

describe('the fetchers say unavailable rather than none', () => {
    it('NHC: every active storm’s a-deck, models and all', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) =>
                String(url).endsWith('CurrentStorms.json')
                    ? new Response(JSON.stringify({ activeStorms: [{ id: 'al312026' }, { id: '../etc' }] }))
                    : String(url).endsWith('/aal312026.dat.gz')
                      ? new Response(gzipSync(atlantic))
                      : new Response('missing', { status: 404 }),
            ),
        );
        const nhc = (await fetchNhcAdecks(NOW))!;
        expect(nhc.storms).toBe(1);
        expect(
            modelTracks(parseAdeck(nhc.text), NOW)
                .map((m) => m.label)
                .sort(),
        ).toEqual(['Consensus', 'ECMWF', 'GFS', 'UKMO']);
    });

    it('NHC down is null', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 503 })),
        );
        expect(await fetchNhcAdecks(NOW + 3_600_000)).toBeNull();
    });

    it('GFS: the newest cycle on NOMADS, else the one before, else null', async () => {
        const urls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                urls.push(String(url));
                return String(url).includes('/12/') ? new Response(atlantic) : new Response('', { status: 404 });
            }),
        );
        expect((await fetchGfsAtcfunix(NOW))?.cycle).toBe('2026101312');
        // The tracker moved to ens_tracker/…/tctrack (the old atmos/ path answers 403, 2026-10-14).
        expect(urls[0]).toBe(
            'https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/gfs.20261013/12/tctrack/avno.t12z.cyclone.trackatcfunix',
        );
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 404 })),
        );
        expect(await fetchGfsAtcfunix(NOW)).toBeNull();
    });

    it('GFS: the old atmos/ path is still tried when the new one does not answer', async () => {
        const urls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                urls.push(String(url));
                return String(url).endsWith('gfs.t12z.atcfunix.all')
                    ? new Response(atlantic)
                    : new Response('Forbidden', { status: 403 });
            }),
        );
        expect((await fetchGfsAtcfunix(NOW))?.cycle).toBe('2026101312');
        expect(urls).toContain(
            'https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs.20261013/12/atmos/gfs.t12z.atcfunix.all',
        );
    });
});
