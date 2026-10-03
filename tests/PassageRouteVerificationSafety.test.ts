import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRouteSegments } from '../services/isochrone/landAvoidance';
import {
    BLOCKED_LEAD_DASH,
    UNVERIFIED_ROUTE_DASH,
    inshoreRouteLineLayers,
    unverifiedRouteDashLayers,
} from '../components/map/inshoreRouteState';
import { NAV_LAYER_IDS } from '../components/map/isobarLayerSetup';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const plannerSource = read('components/map/usePassagePlanner.ts');
const stateSource = read('components/map/inshoreRouteState.ts');
const mapInitSource = read('components/map/useMapInit.ts');
const routerEventsSource = read('components/map/usePassageRouterEvents.ts');
const bannerSource = read('components/map/PassageBanner.tsx');
const validationSource = read('services/isochrone/landAvoidance.ts');
const autoSource = read('components/autorouting/AutoroutingTrialWorkspace.tsx');
const legendSource = read('components/map/RouteLegend.tsx');
const chartKeySource = read('components/map/ChartKeyPanel.tsx');
const noticeSource = read('components/map/inshoreRouteNotice.ts');
const leadsSource = read('components/map/useChartLeadsLayer.ts');

/** WCAG relative luminance of a #rrggbb ink. */
function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('Passage Planner fail-closed route verification contract', () => {
    it('returns an explicit unverified outcome when geometry cannot be validated', async () => {
        const outcomes: Array<{ status: string; reason?: string }> = [];
        await validateRouteSegments(
            [
                {
                    lat: -27.5,
                    lon: 153,
                    timeHours: 0,
                    bearing: 0,
                    speed: 6,
                    tws: 0,
                    twa: 0,
                    parentIndex: null,
                    distance: 0,
                },
            ],
            { onVerificationOutcome: (outcome) => outcomes.push(outcome) },
        );

        expect(outcomes).toEqual([{ status: 'unverified', reason: 'route has fewer than two points' }]);
    });

    it('renders previews and missing/mismatched inshore masks as explicit unverified dashes', () => {
        expect(plannerSource).toContain("safety: 'unverified'");
        expect(plannerSource).toContain('dashed: true');
        // The per-segment classification moved to a pure module (fix-up,
        // 2026-09-30: charted-shallow water beats a channel's yellow); the
        // planner draws its null as the unverified dashes.
        expect(plannerSource).toContain('const stateMask = inshoreSegmentStates(inshoreRes);');
        expect(stateSource).toContain('inshoreMasksVerified');
        expect(stateSource).toContain('hasMask(cautionMask) &&');
        expect(stateSource).toContain('hasMask(canalMask) &&');
        expect(stateSource).toContain('hasMask(channelMask) &&');
        expect(stateSource).toContain('hasMask(offshoreMask)');
        expect(plannerSource).not.toContain('No (or mismatched) safety data — single green line');
        expect(plannerSource).not.toContain("properties: { safety: 'green', source: 'inshore-router' }");
    });

    it('keeps timeout and failure outcomes unverified instead of repainting them safe', () => {
        expect(plannerSource).toContain('final chart and coarse depth validation timed out after 15 seconds');
        expect(plannerSource).toContain('markRouteUnverified(isoResult.routeCoordinates, reason, true)');
        expect(plannerSource).toContain("status: 'unverified'");
        expect(plannerSource).toContain('success: false, verified: false');
        expect(validationSource).toContain("status: 'unverified', reason: 'chart/depth hazard query failed'");
        expect(validationSource).toContain('reason: `route validation hit its ${MAX_VALIDATION_PASSES}-pass limit`');
    });

    it('freshly verifies cached, final long-route, and stitched multi-leg geometry before promotion', () => {
        expect(plannerSource).toContain(
            'validateCandidateRoute(\n                            withPassageTerminals(cached.route)',
        );
        expect(plannerSource).toContain('withPassageTerminals(isoResult.route)');
        expect(plannerSource).toContain('stitched multi-leg route is awaiting whole-route verification');
        expect(plannerSource).toContain(
            "buildFeatures(isoResult.routeCoordinates, isoResult.shallowFlags, 'verified', true)",
        );
        expect(plannerSource).toContain('isoResultRef.current = isoResult');
    });

    it('styles every unverified and progressive preview as bright red DASHES, never green and never solid', () => {
        // Shane 2026-10-03: "as long as they are a bright red, it should be
        // fine". They were amber dashes — the leads' own colour. Red dashes
        // are "not checked"; solid red is "checked and dangerous".
        expect(UNVERIFIED_ROUTE_DASH.ink).toBe('#ff1744');
        expect(UNVERIFIED_ROUTE_DASH.dasharray.length).toBe(2);
        const [casing, gap, dash] = unverifiedRouteDashLayers('route-line');
        expect([casing.id, gap.id, dash.id]).toEqual([
            'route-unverified-casing',
            'route-unverified-gap',
            'route-unverified',
        ]);
        expect(dash.paint['line-color']).toBe('#ff1744');
        expect(dash.paint['line-dasharray']).toEqual([...UNVERIFIED_ROUTE_DASH.dasharray]);
        expect(casing.paint['line-color']).toBe(UNVERIFIED_ROUTE_DASH.casing);
        expect(casing.paint['line-width']).toBeGreaterThan(dash.paint['line-width']);
        // Every unverified piece is dashed, dashed flag or not…
        for (const layer of [casing, gap, dash]) expect(layer.filter).toEqual(['==', ['get', 'safety'], 'unverified']);
        // …and no solid layer ever paints one: an unchecked line cannot read
        // as the solid red of a checked danger.
        for (const solid of inshoreRouteLineLayers('route-line')) {
            expect(solid.filter).toContainEqual(['!=', ['get', 'safety'], 'unverified']);
            expect(JSON.stringify(solid.paint)).not.toContain('"unverified"');
        }
        // The planner map, the progressive preview and Auto's map all draw it.
        expect(mapInitSource).toContain("inshoreRouteLineLayers('route-line')");
        expect(mapInitSource).toContain("unverifiedRouteDashLayers('route-line')");
        expect(mapInitSource).not.toContain("'unverified', '#f59e0b'");
        expect(routerEventsSource).toContain("unverifiedRouteDashLayers('route-preview', 'route-preview')");
        expect(routerEventsSource).toContain("properties: { safety: 'unverified' }");
        expect(routerEventsSource).not.toContain("'line-color': '#f59e0b'");
        expect(routerEventsSource).not.toContain("'line-color': '#00e676'");
        expect(autoSource).toContain("unverifiedRouteDashLayers('thalassa-route', 'thalassa-route')");
        expect(autoSource).not.toContain("'line-color': '#f59e0b'");
        // The keys say red, and no copy calls the unverified line amber.
        expect(legendSource).toContain('UNVERIFIED_ROUTE_DASH.ink');
        expect(chartKeySource).toContain('UNVERIFIED_ROUTE_DASH.ink');
        for (const source of [plannerSource, noticeSource, legendSource, chartKeySource])
            expect(source).not.toMatch(/dashed amber line/);
        expect(plannerSource).toContain('The dashed red line cannot be saved, exported or shared.');
    });

    // Review fix-up (2026-10-03): the leads overlay's BLOCKED lead (a bridge or
    // power line the mast cannot clear) is red dashes on this same dark casing
    // at nearly the same width and rhythm, and the planner map shows both. The
    // unverified line keeps Shane's bright red, but its gaps are PALE — red
    // and white dashes on a dark edge — so the two never read as one.
    it('the unverified line never looks like a blocked lead: red and white dashes, not red on dark', () => {
        const [casing, gap, dash] = unverifiedRouteDashLayers('route-line');
        // The gap: a pale solid line under the dashes, exactly as wide, on the
        // dark casing.
        expect(gap.paint['line-color']).toBe(UNVERIFIED_ROUTE_DASH.gap);
        expect(gap.paint['line-width']).toBe(dash.paint['line-width']);
        expect(gap.paint['line-opacity']).toBe(1);
        expect('line-dasharray' in gap.paint).toBe(false);
        expect(casing.paint['line-width']).toBeGreaterThan(gap.paint['line-width']);
        expect(luminance(UNVERIFIED_ROUTE_DASH.gap)).toBeGreaterThan(0.8);
        // The blocked lead's gaps show its dark casing.
        expect(luminance(BLOCKED_LEAD_DASH.casing)).toBeLessThan(0.05);
        // Pattern, ink and gap all differ from the blocked lead's.
        expect([...UNVERIFIED_ROUTE_DASH.dasharray]).not.toEqual([...BLOCKED_LEAD_DASH.dasharray]);
        expect(UNVERIFIED_ROUTE_DASH.ink).not.toBe(BLOCKED_LEAD_DASH.ink);
        expect(UNVERIFIED_ROUTE_DASH.gap).not.toBe(BLOCKED_LEAD_DASH.casing);
        // The leads overlay draws its blocked lead from that one spec…
        expect(leadsSource).toContain('BLOCKED_INK = BLOCKED_LEAD_DASH.ink');
        expect(leadsSource).toContain("'line-dasharray': [...BLOCKED_LEAD_DASH.dasharray]");
        // …and the chart key shows each in its own pattern.
        expect(chartKeySource).toContain('UNVERIFIED_ROUTE_DASH.gap');
        expect(chartKeySource).toContain('BLOCKED_LEAD_DASH.ink');
        expect(chartKeySource).toContain('BLOCKED_LEAD_DASH.casing');
        expect(legendSource).toContain('UNVERIFIED_ROUTE_DASH.gap');
        // The planner map lifts the three layers above the weather in order.
        const navIds: readonly string[] = NAV_LAYER_IDS;
        const order = ['route-unverified-casing', 'route-unverified-gap', 'route-unverified'].map((id) =>
            navIds.indexOf(id),
        );
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('binds Save, GPX and Brief availability to the exact verified displayed geometry', () => {
        expect(plannerSource).toContain("routeVerification.status === 'verified'");
        expect(plannerSource).toContain('routeVerification.geometryKey === displayedRouteGeometryKeyRef.current');
        expect(bannerSource).toContain('passage.routeActionsAvailable');
        expect(bannerSource).toContain('currentRouteVerified && (');
        expect(bannerSource).toContain(
            'Save, GPX export and Brief sharing stay unavailable until this exact line passes.',
        );
    });
});
