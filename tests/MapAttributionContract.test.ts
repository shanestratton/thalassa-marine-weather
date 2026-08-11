import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('map provider attribution contract', () => {
    it('keeps native attribution chrome and source credits on the primary chart map', () => {
        const source = read('components/map/useMapInit.ts');

        expect(source).toContain('attributionControl: true');
        expect(source).toMatch(/map\.addSource\('satellite-base',[\s\S]*?attribution:[\s\S]*?Mapbox[\s\S]*?Maxar/);
        expect(source).toMatch(/map\.addSource\('hybrid-base',[\s\S]*?attribution:[\s\S]*?Mapbox[\s\S]*?OpenStreetMap/);
        expect(source).toMatch(
            /map\.addSource\('maptiler-ocean',[\s\S]*?attribution:[\s\S]*?MapTiler[\s\S]*?OpenStreetMap/,
        );
        expect(source).toMatch(/map\.addSource\('openseamap-permanent',[\s\S]*?attribution:[\s\S]*?OpenSeaMap/);
        expect(source).not.toMatch(/attribution:\s*['"]\s*['"]/);
    });

    it('keeps attribution enabled on the public voyage and offline chart map surfaces', () => {
        const voyageMap = read('src/components/MapContainer.tsx');
        const offlineMap = read('components/map/ThalassaMap.tsx');

        expect(voyageMap).toMatch(/<Map[\s\S]*?attributionControl/);
        expect(voyageMap).toMatch(/id="bathy-ocean"[\s\S]*?attribution="[^"]*MapTiler[^"]*OpenStreetMap/);
        expect(offlineMap).toMatch(/<Map[\s\S]*?attributionControl/);
        expect(offlineMap).toMatch(/attribution:[\s\S]*?OpenStreetMap/);
        expect(offlineMap).toMatch(/attribution:[\s\S]*?OpenSeaMap/);
    });

    it('does not hide provider attribution controls or logos in global CSS', () => {
        const css = `${read('index.css')}\n${read('logs.html')}`;
        // Mapbox / MapLibre attribution and logo: untouchable, full stop.
        const forbiddenSelectors = ['.mapboxgl-ctrl-attrib', '.mapboxgl-ctrl-logo', '.maplibregl-ctrl-attrib'];
        for (const selector of forbiddenSelectors) {
            expect(css).not.toContain(selector);
        }

        // Leaflet attribution MAY be restyled — the stock white pill on the
        // dark Log maps was the ugliest thing aboard (Shane 2026-08-12) —
        // but the contract this test guards is VISIBILITY, not virginity:
        // every rule that mentions it must keep it shown and legible. The
        // blunt "selector must not appear" form couldn't tell a dark-glass
        // restyle from a hide, and refusing all styling is how the white
        // pill survived this long.
        const hidingVocabulary = [
            /display:\s*none/,
            /visibility:\s*hidden/,
            /opacity:\s*0(?![.\d])/,
            /font-size:\s*0(?![.\d])/,
            /color:\s*transparent/,
            /width:\s*0(?![.\d])/,
            /height:\s*0(?![.\d])/,
        ];
        const attributionBlocks = css.split('}').filter((block) => block.includes('.leaflet-control-attribution'));
        for (const block of attributionBlocks) {
            for (const pattern of hidingVocabulary) {
                expect(block).not.toMatch(pattern);
            }
        }
    });
});
