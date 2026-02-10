import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VesselWidget } from './TideAndVessel';
import { VesselProfile } from '../../types';

// Mock CelestialComponents since TideAndVessel re-exports from it
vi.mock('./tide/CelestialComponents', () => ({
    MoonVisual: () => <div />,
    SolarArc: () => <div />,
    getMoonPhaseData: () => ({ phase: 'Full Moon', illumination: 100, emoji: '🌕' }),
}));

describe('VesselWidget', () => {
    const sailVessel: VesselProfile = {
        name: 'Sea Breeze',
        type: 'sail',
        length: 36,
        beam: 12,
        displacement: 16000,
    } as VesselProfile;

    it('renders observer mode fallback when vessel type is observer', () => {
        const observerVessel = { name: 'Observer', type: 'observer', length: 0 } as VesselProfile;
        render(<VesselWidget vessel={observerVessel} vesselStatus={{}} />);

        expect(screen.getByText('Observer Mode')).toBeDefined();
        expect(screen.getByText(/configure a vessel/i)).toBeDefined();
    });

    it('renders vessel details for sail vessel', () => {
        render(<VesselWidget vessel={sailVessel} vesselStatus={{ status: 'safe' }} />);

        expect(screen.getByText('Sea Breeze')).toBeDefined();
        expect(screen.getByText('Within Limits')).toBeDefined();
        expect(screen.getByText('Hull Speed')).toBeDefined();
        expect(screen.getByText('Displacement')).toBeDefined();
    });

    it('shows Limits Exceeded for unsafe status', () => {
        render(<VesselWidget vessel={sailVessel} vesselStatus={{ status: 'unsafe' }} />);

        expect(screen.getByText('Limits Exceeded')).toBeDefined();
    });
});
