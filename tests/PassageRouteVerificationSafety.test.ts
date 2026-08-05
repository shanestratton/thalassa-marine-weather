import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRouteSegments } from '../services/isochrone/landAvoidance';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const plannerSource = read('components/map/usePassagePlanner.ts');
const mapInitSource = read('components/map/useMapInit.ts');
const routerEventsSource = read('components/map/usePassageRouterEvents.ts');
const bannerSource = read('components/map/PassageBanner.tsx');
const validationSource = read('services/isochrone/landAvoidance.ts');

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
        expect(plannerSource).toContain('inshoreMasksVerified');
        expect(plannerSource).toContain('hasMask(cautionMask) &&');
        expect(plannerSource).toContain('hasMask(canalMask) &&');
        expect(plannerSource).toContain('hasMask(channelMask) &&');
        expect(plannerSource).toContain('hasMask(offshoreMask)');
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

    it('styles every unverified and progressive preview as amber/grey rather than green', () => {
        expect(mapInitSource).toContain("'unverified',\n                        '#f59e0b'");
        expect(mapInitSource).toContain("['match', ['get', 'safety'], 'unverified', '#f59e0b', '#38bdf8']");
        expect(routerEventsSource).toContain("'line-color': '#f59e0b'");
        expect(routerEventsSource).not.toContain("'line-color': '#00e676'");
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
