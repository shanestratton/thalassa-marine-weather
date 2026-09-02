/**
 * Hemispheres come from the sign of the coordinate, never from a literal.
 *
 * StopDetailView printed `${lat}°N, ${abs(lon)}°W` — so Townsville read
 * "-19.260°N, 146.820°W", wrong in both halves, on an Australian app
 * (audit 2026-09-02). It now goes through utils/format's formatCoordinate.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/geminiService', () => ({ fetchStopDetails: vi.fn(() => Promise.resolve(null)) }));

import { StopDetailView } from '../components/map/MapUI';

describe('StopDetailView coordinates', () => {
    it('shows S and E for a southern-hemisphere, eastern-longitude stop', async () => {
        render(
            <StopDetailView
                waypoint={{ name: 'Townsville', coordinates: { lat: -19.26, lon: 146.82 } } as never}
                onClose={() => {}}
            />,
        );
        const line = await screen.findByText(/19\.2600°S/);
        expect(line.textContent).toContain('146.8200°E');
        expect(line.textContent).not.toMatch(/°N|°W|-19/);
    });

    it('still shows N and W where they are true', async () => {
        render(
            <StopDetailView
                waypoint={{ name: 'Newport RI', coordinates: { lat: 41.49, lon: -71.31 } } as never}
                onClose={() => {}}
            />,
        );
        const line = await screen.findByText(/41\.4900°N/);
        expect(line.textContent).toContain('71.3100°W');
    });
});
