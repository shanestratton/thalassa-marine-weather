import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ObsLayerKey, obsLayerKeyCount, type ObsLayerKeyProps } from '../components/map/ObsLayerKey';
import { BlitzortungAttribution } from '../components/map/BlitzortungAttribution';

vi.mock('../services/AisGuardZone', () => ({
    AisGuardZone: {
        getState: () => ({ enabled: false, radiusNm: 2, alerts: [] }),
        subscribe: () => () => undefined,
        setEnabled: vi.fn(),
        setRadius: vi.fn(),
    },
}));
vi.mock('../services/weather/api/blitzortungLightning', () => ({
    subscribeLightningStatus: (listener: (value: unknown) => void) => {
        listener({ status: 'stalled', retryAttempts: 1, viewportCount: 0, viewportRate: 0 });
        return () => undefined;
    },
}));

function props(overrides: Partial<ObsLayerKeyProps> = {}): ObsLayerKeyProps {
    return {
        ais: false,
        lightning: false,
        squall: false,
        storms: false,
        tides: false,
        moorings: false,
        anchorages: false,
        marks: false,
        protectedAreas: false,
        route: false,
        track: false,
        passage: false,
        forecastRoute: false,
        verificationStatus: 'idle',
        referenceStatus: 'Cached reference',
        mooringFilter: 'all',
        onMooringFilter: vi.fn(),
        tideStatus: { stationCount: 0, loading: false, error: false, zoomRequired: false },
        ...overrides,
    };
}

describe('shared OBS layer key', () => {
    it('includes the real ENC key in normal flow and distinguishes a future tide', () => {
        const p = props({
            enc: {
                imageryOn: false,
                tideDepthMode: true,
                draftConfigured: true,
                tideTimeLabel: 'at the selected tide time (+2 h)',
            },
        });
        render(<ObsLayerKey {...p} />);
        expect(obsLayerKeyCount(p)).toBe(1);
        expect(screen.getByRole('region', { name: 'Nautical chart key' })).not.toHaveClass('absolute');
        expect(screen.queryByRole('button', { name: 'Close chart key' })).not.toBeInTheDocument();
        expect(screen.getByText(/Numbers are metres of water at the selected tide time/)).toBeInTheDocument();
        expect(screen.getByText('0–2')).toBeInTheDocument();
    });
    it('only explains active layers and keeps one embedded AIS guard and mooring filter', () => {
        const p = props({ ais: true, moorings: true, anchorages: true, route: true });
        render(<ObsLayerKey {...p} />);
        expect(obsLayerKeyCount(p)).toBe(4);
        expect(screen.getAllByRole('button', { name: 'Enable AIS guard zone' })).toHaveLength(1);
        expect(screen.getByRole('group', { name: 'AIS vessel colours and guard controls' })).toHaveStyle({
            position: 'static',
        });
        const key = screen.getByRole('region', { name: 'Moorings and anchorages key' });
        expect(key).not.toHaveClass('absolute');
        fireEvent.change(within(key).getByRole('combobox', { name: 'Buoy body colour' }), {
            target: { value: 'blue-white' },
        });
        expect(p.onMooringFilter).toHaveBeenCalledWith('blue-white');
        expect(screen.getByText(/Green is not clearance/)).toBeInTheDocument();
        expect(screen.getByText(/Purple · planned route/)).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Tide stations key' })).not.toBeInTheDocument();
        expect(screen.queryByText(/Amber · recorded track/)).not.toBeInTheDocument();
    });
    it('distinguishes tide zoom, loading, error and genuine empty coverage', () => {
        const p = props({ tides: true });
        const view = render(<ObsLayerKey {...p} tideStatus={{ ...p.tideStatus, zoomRequired: true }} />);
        expect(screen.getByRole('status')).toHaveTextContent('Zoom in to level 6');
        view.rerender(<ObsLayerKey {...p} tideStatus={{ ...p.tideStatus, loading: true }} />);
        expect(screen.getByRole('status')).toHaveTextContent('Loading nearby tide stations');
        view.rerender(<ObsLayerKey {...p} tideStatus={{ ...p.tideStatus, error: true }} />);
        expect(screen.getByRole('alert')).toHaveTextContent('cached');
        view.rerender(<ObsLayerKey {...p} />);
        expect(screen.getByRole('status')).toHaveTextContent('0 nearby stations loaded · coverage is not worldwide');
    });
    it('retains uncertainty for squalls, storms, chart references and protected areas', () => {
        render(<ObsLayerKey {...props({ squall: true, storms: true, protectedAreas: true, marks: true })} />);
        expect(screen.getByText(/does not measure gusts/)).toBeInTheDocument();
        expect(screen.getByText(/missing forecasts are not extrapolated/)).toBeInTheDocument();
        expect(screen.getByText(/Indicative CAPAD classes, not permissions/)).toBeInTheDocument();
        expect(screen.getByText(/Missing mapped marks do not mean clear water/)).toBeInTheDocument();
    });
    it('keeps lightning credit and connection status visible in compact mode without duplicating the key', () => {
        render(<BlitzortungAttribution visible compact />);
        expect(screen.getByRole('link', { name: 'Blitzortung.org' })).toBeInTheDocument();
        expect(screen.getByText('Stalled — reconnecting')).toBeInTheDocument();
        expect(screen.queryByText('+CG')).not.toBeInTheDocument();
    });
});
