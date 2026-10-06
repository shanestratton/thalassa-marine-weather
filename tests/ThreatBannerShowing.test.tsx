/**
 * ThreatBanner tells MapHub whether it is on screen, so Obs's position
 * message can sit below it rather than under it (review 2026-10-06).
 */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/weather/api/blitzortungLightning', () => ({ subscribeLightningStrikes: () => () => {} }));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { ThreatBanner } from '../components/map/ThreatBanner';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';

const HERE = { lat: -19.26, lon: 146.82 };
const cyclone = {
    sid: 'sh012027',
    name: 'Fictional',
    basin: 'SH',
    category: 2,
    categoryLabel: '2',
    currentPosition: { lat: -17.5, lon: 149.5, windKts: 85 },
    track: [],
    forecastTrack: [],
    maxWindKts: 85,
    minPressureMb: null,
    nature: 'TC',
} as unknown as ActiveCyclone;

afterEach(cleanup);

describe('ThreatBanner onShowingChange', () => {
    it('says true while a threat shows and false once it is hidden or gone', async () => {
        const onShowingChange = vi.fn();
        const props = {
            userLat: HERE.lat,
            userLon: HERE.lon,
            lightningActive: false,
            flyTo: vi.fn(),
            onShowingChange,
        };
        const { rerender, unmount } = render(<ThreatBanner {...props} visible cyclones={[cyclone]} />);
        await act(async () => {});
        expect(screen.getByRole('button', { name: /Threat alert/ })).toBeInTheDocument();
        expect(onShowingChange).toHaveBeenLastCalledWith(true);
        rerender(<ThreatBanner {...props} visible={false} cyclones={[cyclone]} />);
        expect(onShowingChange).toHaveBeenLastCalledWith(false);
        rerender(<ThreatBanner {...props} visible cyclones={[cyclone]} />);
        await act(async () => {});
        expect(onShowingChange).toHaveBeenLastCalledWith(true);
        unmount();
        expect(onShowingChange).toHaveBeenLastCalledWith(false);
    });

    it('says false with nothing near', async () => {
        const onShowingChange = vi.fn();
        render(
            <ThreatBanner
                visible
                userLat={HERE.lat}
                userLon={HERE.lon}
                cyclones={[]}
                lightningActive={false}
                flyTo={vi.fn()}
                onShowingChange={onShowingChange}
            />,
        );
        await act(async () => {});
        expect(onShowingChange).not.toHaveBeenCalledWith(true);
        expect(onShowingChange).toHaveBeenLastCalledWith(false);
    });
});
