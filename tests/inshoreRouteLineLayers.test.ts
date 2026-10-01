/**
 * The planner's route-line paint, shared (2026-10-01): Auto draws a Thalassa
 * route in exactly the planner's Phase 2a colours, so the table lives in one
 * place (inshoreRouteState inshoreRouteLineLayers) and both maps use it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inshoreRouteLineLayers, NEEDS_TIDE_AMBER, surveyDashLayers } from '../components/map/inshoreRouteState';

/** The planner's colours, as they were inline in useMapInit before 2026-10-01. */
const LINE = {
    safe: '#00e676',
    caution: '#ff9100',
    tide: NEEDS_TIDE_AMBER,
    danger: '#ff1744',
    unverified: '#f59e0b',
    channel: '#facc15',
    harbour: '#38bdf8',
    offshore: '#1e40af',
};
const CORE = {
    safe: '#b9f6ca',
    caution: '#ffe0b2',
    tide: '#ffe0b2',
    danger: '#ffcdd2',
    unverified: '#cbd5e1',
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
    it('pins the planner route colours: glow, line and core, solid pieces only', () => {
        const [glow, line, core] = inshoreRouteLineLayers('route-line');
        const solid = ['all', ['!=', ['get', 'dashed'], true], ['!=', ['get', 'safety'], 'survey']];
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
        expect(ids).toEqual(['thalassa-route-glow', 'thalassa-route-line-layer', 'thalassa-route-core']);
        expect(surveyDashLayers('thalassa-route').every((layer) => layer.source === 'thalassa-route')).toBe(true);
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
