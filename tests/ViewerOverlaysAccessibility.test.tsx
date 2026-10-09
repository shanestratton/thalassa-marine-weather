import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackMapViewer } from '../components/TrackMapViewer';
import { VesselSearch } from '../components/map/VesselSearch';
import { supabase } from '../services/supabase';
import { PhotoLightbox } from '../src/components/PhotoLightbox';
import { FakeMapboxMap } from './helpers/fakeMapboxGl';

vi.mock('../services/PiCacheService', () => ({
    piCache: { canDisplayProxiedTiles: () => false, passthroughTileUrl: () => null },
}));

// The track viewer's map is Mapbox GL on Relief + Sat since 125-13b.
vi.mock('mapbox-gl', async () => {
    const { fakeMapboxGl } = await import('./helpers/fakeMapboxGl');
    return { default: fakeMapboxGl };
});

afterEach(() => {
    vi.useRealTimers();
});

function PhotoLightboxHarness() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button onClick={() => setOpen(true)}>Open photos</button>
            {open && (
                <PhotoLightbox
                    photos={['first.jpg', 'second.jpg']}
                    caption="Coral Sea sunset"
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}

function VesselSearchHarness() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button onClick={() => setOpen(true)}>Find vessel</button>
            <VesselSearch visible={open} onClose={() => setOpen(false)} onSelect={() => {}} />
        </>
    );
}

function TrackMapHarness() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button onClick={() => setOpen(true)}>Open voyage track</button>
            <TrackMapViewer isOpen={open} onClose={() => setOpen(false)} entries={[]} />
        </>
    );
}

describe('viewer overlay accessibility', () => {
    it('shows and draws a followed route before the recorded voyage has two fixes', async () => {
        FakeMapboxMap.instances.length = 0;
        vi.stubEnv('VITE_MAPBOX_ACCESS_TOKEN', 'pk.fixture');
        try {
            render(
                <TrackMapViewer
                    isOpen
                    onClose={() => {}}
                    entries={[]}
                    followedRouteCoords={[
                        { lat: -27.5, lon: 153 },
                        { lat: -23.9, lon: 152.4 },
                    ]}
                />,
            );

            expect(screen.getByText('Followed route · waiting for recorded fixes')).toBeInTheDocument();
            expect(screen.queryByText('Loading track…')).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'Play track' })).not.toBeInTheDocument();
            expect(screen.getByText('Route')).toBeInTheDocument();
            await waitFor(() => expect(FakeMapboxMap.instances).toHaveLength(1));
            const map = FakeMapboxMap.instances[0];
            // Framed on the route as the map is made, then drawn when its style lands.
            expect(map.options.bounds).toEqual([
                [152.4, -27.5],
                [153, -23.9],
            ]);
            map.loadStyle();
            await waitFor(() => expect(map.getSource('track-route')).toBeDefined());
            const route = map.getSource('track-route')!.data as GeoJSON.FeatureCollection;
            expect((route.features[0].geometry as GeoJSON.LineString).coordinates).toEqual([
                [153, -27.5],
                [152.4, -23.9],
            ]);
            expect(map.getLayer('track-route-glow')?.paint).toMatchObject({ 'line-color': '#a78bfa' });
            expect(map.getLayer('track-route-core')?.paint).toMatchObject({ 'line-color': '#c4b5fd' });
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('contains photo viewer focus, supports keyboard navigation, and restores its opener', () => {
        render(<PhotoLightboxHarness />);

        const opener = screen.getByRole('button', { name: 'Open photos' });
        opener.focus();
        fireEvent.click(opener);

        expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Close photo viewer' })).toHaveFocus();
        expect(screen.getByRole('img', { name: 'Coral Sea sunset, photo 1 of 2' })).toBeInTheDocument();

        fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
        expect(screen.getByRole('img', { name: 'Coral Sea sunset, photo 2 of 2' })).toBeInTheDocument();

        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Photo viewer' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('focuses vessel search, dismisses on Escape, and restores its opener', () => {
        render(<VesselSearchHarness />);

        const opener = screen.getByRole('button', { name: 'Find vessel' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: 'Search vessels' });
        expect(dialog).toBeInTheDocument();
        expect(dialog.parentElement).toBe(document.body);
        expect(dialog).toHaveAttribute('data-overlay-layer', 'modal');
        expect(screen.getByRole('textbox', { name: 'Vessel name or MMSI' })).toHaveFocus();

        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Search vessels' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('cancels a pending vessel search when the overlay closes', () => {
        vi.useFakeTimers();
        const rpc = vi.mocked(supabase!.rpc);
        rpc.mockClear();
        render(<VesselSearchHarness />);

        fireEvent.click(screen.getByRole('button', { name: 'Find vessel' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Vessel name or MMSI' }), {
            target: { value: 'Aurora' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
        act(() => {
            vi.advanceTimersByTime(400);
        });

        expect(rpc).not.toHaveBeenCalled();
    });

    // The NmeaGaugeOverlay case was removed with the component itself: the
    // legacy overlay and its five gauges had no importer outside this file.

    it('contains voyage-track focus, dismisses on Escape, and restores its opener', () => {
        render(<TrackMapHarness />);

        const opener = screen.getByRole('button', { name: 'Open voyage track' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: 'Voyage track viewer' });
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('data-overlay-layer', 'modal');
        expect(dialog.parentElement).toBe(document.body);
        expect(dialog.style.zIndex).toBe('1100');
        expect(screen.getByRole('button', { name: 'Close track map viewer' })).toHaveFocus();
        expect(screen.queryByRole('slider', { name: 'Track playback position' })).not.toBeInTheDocument();

        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Voyage track viewer' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });
});
