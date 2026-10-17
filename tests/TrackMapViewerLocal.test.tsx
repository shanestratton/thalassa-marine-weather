import React, { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('mapbox-gl', () => {
    throw new Error('Private local replay must not load the map SDK');
});
import LocalTrack, { localTrackGeometry } from '../components/TrackMapViewerLocal';
import type { ShipLogEntry } from '../types';
import type { TrackMapViewerGLHandle } from '../components/TrackMapViewerGL';
const fix = (id: number, seconds: number, lon: number, windSpeed?: number): ShipLogEntry => ({
    id: String(id),
    userId: '',
    voyageId: 'private-fixture',
    timestamp: new Date(1_700_000_000_000 + seconds * 1000).toISOString(),
    latitude: -17,
    longitude: lon,
    positionFormatted: '',
    entryType: 'auto',
    source: 'device',
    windSpeed,
});
describe('private local position plot', () => {
    it('frames the short dateline crossing inside measured control margins', () => {
        const result = localTrackGeometry([fix(1, 0, 179.9), fix(2, 60, -179.9)], 300, 640, {
            top: 280,
            left: 80,
            right: 24,
            bottom: 230,
        });
        expect(result.points[1].lon - result.points[0].lon).toBeCloseTo(0.2);
        expect(result.points[0].x).toBeCloseTo(80);
        expect(result.points[1].x).toBeCloseTo(276);
        expect(result.points[0].y).toBeGreaterThan(280);
        expect(result.points[0].y).toBeLessThan(410);
        expect(result.project(-17, -179.9)).toEqual({ x: result.points[1].x, y: result.points[1].y });
    });
    it('keeps an empty or lone polar fix finite and refuses invalid positions', () => {
        expect(localTrackGeometry([], 300, 640).points).toEqual([]);
        const p = localTrackGeometry(
            [
                { ...fix(1, 0, 20), latitude: 90 },
                { ...fix(2, 60, 20), latitude: NaN },
            ],
            300,
            640,
        ).points;
        expect(p).toHaveLength(1);
        expect(Number.isFinite(p[0].x) && Number.isFinite(p[0].y)).toBe(true);
    });
    it('draws logged segments only, breaks long gaps, retains unknown wind and moves only to given playback fixes', () => {
        const ref = createRef<TrackMapViewerGLHandle>();
        const entries = [fix(1, 0, 179.9, 0), fix(2, 60, -179.9), fix(3, 900, 179.9, 12), fix(4, 960, -179.9, 12)];
        render(
            <LocalTrack
                ref={ref}
                entries={entries}
                followedRoute={[]}
                colorMode="wind"
                tapEntries={entries}
                onUnavailable={vi.fn()}
            />,
        );
        const plot = screen.getByRole('img', { name: /local coordinate plot/ });
        expect(plot.querySelectorAll('[data-recorded-track]')).toHaveLength(2);
        expect(plot.querySelector('[data-recorded-track]')).toHaveAttribute('stroke', '#94a3b8');
        act(() => ref.current!.moveVessel(-17, -179.9));
        const vessel = plot.querySelector('[data-playback-vessel]')!;
        const end = plot.querySelectorAll('g circle')[3];
        expect(vessel.getAttribute('cx')).toBe(end.getAttribute('cx'));
        expect(vessel.getAttribute('cy')).toBe(end.getAttribute('cy'));
        expect(plot.querySelector('image')).toBeNull();
    });
});
