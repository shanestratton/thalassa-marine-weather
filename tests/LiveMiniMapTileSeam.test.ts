import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const liveMiniMapSource = readFileSync(resolve(process.cwd(), 'components/LiveMiniMap.tsx'), 'utf8');
const trackMapViewerSource = readFileSync(resolve(process.cwd(), 'components/TrackMapViewer.tsx'), 'utf8');
const globalStyles = readFileSync(resolve(process.cwd(), 'index.css'), 'utf8');

describe('LiveMiniMap tile compositing', () => {
    it('scopes normal tile compositing to both Log maps instead of inheriting Leaflet plus-lighter seams', () => {
        expect(liveMiniMapSource).toContain('thalassa-log-leaflet-map live-mini-map w-full');
        expect(trackMapViewerSource).toContain('thalassa-log-leaflet-map absolute inset-0');
        expect(globalStyles).toMatch(
            /\.thalassa-log-leaflet-map\.leaflet-container img\.leaflet-tile\s*\{\s*image-rendering: auto;\s*mix-blend-mode: normal;/,
        );
    });
});
