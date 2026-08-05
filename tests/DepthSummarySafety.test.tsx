import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DepthSummaryCard } from '../components/passage/DepthSummaryCard';
import { GebcoDepthService } from '../services/GebcoDepthService';
import { computeRoute, computeRouteFromPolyline, enhanceRouteWithDepth } from '../services/WeatherRoutingService';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('passage depth analysis safety', () => {
    it('never presents unknown-only ETOPO samples as depth clear', () => {
        render(
            <DepthSummaryCard
                vesselDraft={2}
                data={{
                    minDepth: null,
                    shallowSegments: 0,
                    totalSegments: 2,
                    knownSegments: 0,
                    coverage: 'unavailable',
                    sampleSpacingNm: 0.5,
                    routeSource: 'displayed',
                    segments: [
                        { depth_m: null, safety: 'unknown', costMultiplier: 1.2 },
                        { depth_m: null, safety: 'unknown', costMultiplier: 1.2 },
                    ],
                }}
            />,
        );

        expect(screen.getByText('DEPTH NOT VERIFIED')).toBeTruthy();
        expect(screen.queryByText('DEPTH CLEAR')).toBeNull();
        expect(screen.getByText(/not a navigation clearance/i)).toBeTruthy();
    });

    it('constructs the depth candidate route from the displayed polyline bend', () => {
        const analysis = computeRouteFromPolyline(
            [
                [153, -27],
                [153.02, -27],
                [153.02, -27.02],
            ],
            { segmentLength: 0.25 },
        );

        expect(analysis.segments.length).toBeGreaterThan(2);
        expect(analysis.segments.some((segment) => Math.abs(segment.endLon - 153.02) < 0.00001)).toBe(true);
        expect(analysis.segments.at(-1)?.endLat).toBeCloseTo(-27.02, 4);
        expect(analysis.totalDistance).toBeGreaterThan(2);
    });

    it('keeps the 200-point edge cap aligned to evenly selected route segments', async () => {
        const analysis = computeRoute(
            [
                { id: 'a', name: 'A', lat: -27, lon: 153 },
                { id: 'b', name: 'B', lat: -22, lon: 153 },
            ],
            { segmentLength: 0.5 },
        );
        expect(analysis.segments.length).toBeGreaterThan(200);

        const query = vi.spyOn(GebcoDepthService, 'queryDepths').mockImplementation(async (points) =>
            points.map((point) => ({
                ...point,
                depth_m: -Math.abs(point.lat),
            })),
        );

        const enhanced = await enhanceRouteWithDepth(analysis, 2);
        const requested = query.mock.calls[0][0];

        expect(requested).toHaveLength(200);
        expect(enhanced.segments).toHaveLength(200);
        expect(enhanced.depthSamplesKnown).toBe(200);
        expect(enhanced.depthSampleSpacingNm).toBeGreaterThan(1);
        expect(enhanced.segments[0].depth_m).toBeCloseTo(-Math.abs(requested[0].lat), 6);
        expect(enhanced.segments.at(-1)?.endLat).toBeCloseTo(-22, 4);
    });
});
