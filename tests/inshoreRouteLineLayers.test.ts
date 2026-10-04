/**
 * The planner's route-line paint, shared (2026-10-01): Auto draws a Thalassa
 * route in exactly the planner's Phase 2a colours, so the table lives in one
 * place (inshoreRouteState inshoreRouteLineLayers) and both maps use it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NAV_LAYER_IDS } from '../components/map/isobarLayerSetup';
import {
    inshoreRouteLineLayers,
    NEEDS_TIDE_AMBER,
    SURVEY_DASH,
    surveyDashLayers,
} from '../components/map/inshoreRouteState';

/** The planner's colours, as they were inline in useMapInit before 2026-10-01
 *  — less 'unverified' (2026-10-03): an unchecked line is never solid, it is
 *  the red dashes of unverifiedRouteDashLayers — and with 'edge' (round-3
 *  fix-up, 2026-10-03): a channel edge, the needs-tide amber with no chip. */
const LINE = {
    safe: '#00e676',
    caution: '#ff9100',
    tide: NEEDS_TIDE_AMBER,
    edge: NEEDS_TIDE_AMBER,
    danger: '#ff1744',
    channel: '#facc15',
    harbour: '#38bdf8',
    offshore: '#1e40af',
};
const CORE = {
    safe: '#b9f6ca',
    caution: '#ffe0b2',
    tide: '#ffe0b2',
    edge: '#ffe0b2',
    danger: '#ffcdd2',
    channel: '#fcd34d',
    harbour: '#bae6fd',
    offshore: '#93c5fd',
};
const matchOf = (table: Record<string, string>, fallback: string) => [
    'match',
    ['get', 'safety'],
    ...Object.entries(table).flat(),
    fallback,
];

describe('inshoreRouteLineLayers', () => {
    it('pins the planner route colours: glow, casing, line and core, solid pieces only', () => {
        const [glow, casing, line, core] = inshoreRouteLineLayers('route-line');
        const solid = [
            'all',
            ['!=', ['get', 'dashed'], true],
            ['!=', ['get', 'safety'], 'survey'],
            ['!=', ['get', 'safety'], 'unverified'],
        ];
        expect(glow).toEqual({
            id: 'route-glow',
            type: 'line',
            source: 'route-line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': matchOf(LINE, '#2dd4bf'),
                'line-width': 12,
                'line-blur': 10,
                'line-opacity': ['match', ['get', 'safety'], 'harbour', 0.3, 0.6],
            },
            filter: solid,
        });
        expect(casing).toEqual({
            id: 'route-casing',
            type: 'line',
            source: 'route-line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': SURVEY_DASH.casing, 'line-width': 6, 'line-opacity': 0.8 },
            filter: solid,
        });
        expect(line).toEqual({
            id: 'route-line-layer',
            type: 'line',
            source: 'route-line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': matchOf(LINE, '#2dd4bf'), 'line-width': 3, 'line-opacity': 0.9 },
            filter: solid,
        });
        expect(core).toEqual({
            id: 'route-core',
            type: 'line',
            source: 'route-line',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': matchOf(CORE, '#99f6e4'), 'line-width': 1.5 },
            filter: solid,
        });
    });

    it('prefixes ids for another source, so a second map never collides', () => {
        const ids = inshoreRouteLineLayers('thalassa-route', 'thalassa-route').map((layer) => layer.id);
        expect(ids).toEqual([
            'thalassa-route-glow',
            'thalassa-route-casing',
            'thalassa-route-line-layer',
            'thalassa-route-core',
        ]);
        expect(surveyDashLayers('thalassa-route').every((layer) => layer.source === 'thalassa-route')).toBe(true);
    });

    // Review 2026-10-05: with ENC off, Relief's light shallow ramp (2-10 m,
    // #52a6cc..#3886b6) sat at 1.3-2.2:1 against the harbour and default
    // lines, blue on blue, in exactly the water harbour legs cross. A dark
    // edge, as the survey and unverified dashes already have, carries them on
    // any base.
    it('edges the solid line in the dark casing, so it reads on Relief’s light shallows', () => {
        const lum = (hex: string) => {
            const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
            const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
            return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        };
        const ratio = (a: string, b: string) => {
            const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
        };
        const [, casing, line] = inshoreRouteLineLayers('route-line');
        expect(casing.paint['line-width']).toBeGreaterThan(line.paint['line-width'] as number);
        for (const ink of ['#38bdf8', '#2dd4bf', '#00e676', '#facc15'])
            expect(ratio(ink, casing.paint['line-color'] as string), ink).toBeGreaterThan(4.5);
        // The planner map lifts it above the weather, between glow and line.
        const nav: readonly string[] = NAV_LAYER_IDS;
        expect(nav.indexOf('route-casing')).toBeGreaterThan(nav.indexOf('route-glow'));
        expect(nav.indexOf('route-casing')).toBeLessThan(nav.indexOf('route-line-layer'));
    });

    it('is the one table: the planner map and the Auto workspace both use it', () => {
        const mapInit = readFileSync('components/map/useMapInit.ts', 'utf8');
        const workspace = readFileSync('components/autorouting/AutoroutingTrialWorkspace.tsx', 'utf8');
        expect(mapInit).toContain("inshoreRouteLineLayers('route-line')");
        expect(mapInit).not.toContain("'#ff1744'");
        expect(workspace).toContain("inshoreRouteLineLayers('thalassa-route'");
        expect(workspace).toContain("surveyDashLayers('thalassa-route')");
    });
});
