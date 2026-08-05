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
        const forbiddenSelectors = [
            '.mapboxgl-ctrl-attrib',
            '.mapboxgl-ctrl-logo',
            '.maplibregl-ctrl-attrib',
            '.leaflet-control-attribution',
        ];

        for (const selector of forbiddenSelectors) {
            expect(css).not.toContain(selector);
        }
    });
});
