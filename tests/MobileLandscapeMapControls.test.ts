import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('index.css', 'utf8');
const helm = readFileSync('components/map/RadialHelmMenu.tsx', 'utf8');
const mapHub = readFileSync('components/map/MapHub.tsx', 'utf8');

describe('short mobile landscape map controls', () => {
    it('moves the helm grid into a bounded, scrollable wide-axis panel', () => {
        expect(helm).toContain('radial-helm-layer-grid');
        expect(css).toMatch(
            /@media \(orientation: landscape\) and \(max-height: 500px\)[\s\S]*\.radial-helm-layer-grid[\s\S]*bottom:[\s\S]*overflow-y: auto/,
        );
    });

    it('gives the expanded tracer positive top and bottom bounds', () => {
        expect(mapHub).toContain('map-tracer-panel');
        expect(mapHub).toContain('map-tracer-card');
        expect(css).toMatch(/\.map-tracer-panel[\s\S]*top:[\s\S]*bottom:/);
    });
});
