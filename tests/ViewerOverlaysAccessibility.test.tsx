import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackMapViewer } from '../components/TrackMapViewer';
import { VesselSearch } from '../components/map/VesselSearch';
import { NmeaGaugeOverlay } from '../components/nmea/NmeaGaugeOverlay';
import { supabase } from '../services/supabase';
import { PhotoLightbox } from '../src/components/PhotoLightbox';

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        leafletTileTemplate: (url: string) => url,
    },
}));

const trackMapLeaflet = vi.hoisted(() => {
    const groups: Array<ReturnType<typeof makeLayer>> = [];

    function makeLayer() {
        const layer = {
            addTo: vi.fn(),
            bringToFront: vi.fn(),
            clearLayers: vi.fn(),
        };
        layer.addTo.mockReturnValue(layer);
        return layer;
    }

    const map = {
        closePopup: vi.fn(),
        createPane: vi.fn(() => ({ style: {} })),
        fitBounds: vi.fn(),
        hasLayer: vi.fn(() => false),
        invalidateSize: vi.fn(),
        on: vi.fn(),
        remove: vi.fn(),
        removeLayer: vi.fn(),
        setView: vi.fn(),
    };
    map.setView.mockReturnValue(map);
    map.on.mockReturnValue(map);

    const layerGroup = vi.fn(() => {
        const group = makeLayer();
        groups.push(group);
        return group;
    });

    return {
        groups,
        map,
        circleMarker: vi.fn(makeLayer),
        divIcon: vi.fn(() => ({})),
        latLngBounds: vi.fn(() => ({})),
        layerGroup,
        marker: vi.fn(makeLayer),
        polyline: vi.fn(makeLayer),
        popup: vi.fn(makeLayer),
        tileLayer: vi.fn(makeLayer),
    };
});

vi.mock('leaflet', () => {
    return {
        default: {
            circleMarker: trackMapLeaflet.circleMarker,
            divIcon: trackMapLeaflet.divIcon,
            latLngBounds: trackMapLeaflet.latLngBounds,
            layerGroup: trackMapLeaflet.layerGroup,
            map: vi.fn(() => trackMapLeaflet.map),
            marker: trackMapLeaflet.marker,
            polyline: trackMapLeaflet.polyline,
            popup: trackMapLeaflet.popup,
            tileLayer: trackMapLeaflet.tileLayer,
        },
    };
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

function NmeaGaugeHarness() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button onClick={() => setOpen(true)}>Open instrument</button>
            {open && (
                <NmeaGaugeOverlay
                    metricId="cog"
                    metric={{ value: 127, lastUpdated: Date.now(), freshness: 'live' }}
                    onClose={() => setOpen(false)}
                />
            )}
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
        trackMapLeaflet.groups.length = 0;
        trackMapLeaflet.polyline.mockClear();
        trackMapLeaflet.latLngBounds.mockClear();
        trackMapLeaflet.map.fitBounds.mockClear();
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
        await vi.waitFor(() => expect(trackMapLeaflet.polyline).toHaveBeenCalledTimes(2));
        expect(trackMapLeaflet.polyline).toHaveBeenNthCalledWith(
            1,
            [
                [-27.5, 153],
                [-23.9, 152.4],
            ],
            expect.objectContaining({ color: '#a78bfa', pane: 'followed-route-pane' }),
        );
        expect(trackMapLeaflet.polyline).toHaveBeenNthCalledWith(
            2,
            [
                [-27.5, 153],
                [-23.9, 152.4],
            ],
            expect.objectContaining({ color: '#c4b5fd', pane: 'followed-route-pane' }),
        );
        expect(trackMapLeaflet.latLngBounds).toHaveBeenCalledWith([
            [-27.5, 153],
            [-23.9, 152.4],
        ]);
        expect(trackMapLeaflet.map.fitBounds).toHaveBeenCalled();
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

    it('gives the NMEA gauge a labelled modal lifecycle', () => {
        vi.useFakeTimers();
        render(<NmeaGaugeHarness />);

        const opener = screen.getByRole('button', { name: 'Open instrument' });
        opener.focus();
        fireEvent.click(opener);

        expect(screen.getByRole('dialog', { name: 'Course Over Ground' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Go back' })).toHaveFocus();

        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(screen.queryByRole('dialog', { name: 'Course Over Ground' })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

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
