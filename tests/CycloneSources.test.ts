/**
 * The cyclone feeds' readers (129-09, _shared/cyclone/sources.ts), run on
 * stubbed responses: NHC's a-decks are gzipped and their newest cycles are at
 * the end, so they are streamed through, not truncated; and a feed that does
 * not answer is null (unavailable), never an empty list of storms.
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    adeckLinesSince,
    fetchEsriForecast,
    fetchGfsAtcfunix,
    fetchNhcAdecks,
} from '../supabase/functions/_shared/cyclone/sources';
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
        expect(urls[0]).toContain('gfs.20261013/12/atmos/gfs.t12z.atcfunix.all');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 404 })),
        );
        expect(await fetchGfsAtcfunix(NOW)).toBeNull();
    });

    it('Esri: the feed parsed, and null when it does not answer or answers nonsense', async () => {
        const body = readFileSync('tests/fixtures/cyclone/esri-forecast.json', 'utf8');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/plain' } })),
        );
        expect((await fetchEsriForecast())?.map((s) => s.key).sort()).toEqual(['EP41', 'SH37', 'SH38']);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('<!DOCTYPE html>')),
        );
        expect(await fetchEsriForecast()).toBeNull();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('offline');
            }),
        );
        expect(await fetchEsriForecast()).toBeNull();
    });
});
