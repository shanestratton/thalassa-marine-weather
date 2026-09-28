import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteTrackPicker } from '../components/map/RouteTrackPicker';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const loadSavedRouteLibrary = vi.hoisted(() => vi.fn());
const fetchSeaVoyageChoices = vi.hoisted(() => vi.fn());
const fetchVoyageAsTrack = vi.hoisted(() => vi.fn());
const triggerHaptic = vi.hoisted(() => vi.fn());

vi.mock('../services/shiplog/RoutesAndTracks', () => ({ fetchSeaVoyageChoices, fetchVoyageAsTrack }));
vi.mock('../services/savedRouteLibrary', () => ({ loadSavedRouteLibrary }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic,
}));
vi.mock('../utils/useDeviceClass', () => ({
    useDeviceClass: () => 'phone',
    pickByDevice: <T,>(_device: string, phone: T) => phone,
}));

const route: RouteOrTrack = {
    id: 'planned-moreton',
    label: 'Brisbane to Moreton',
    sublabel: '18 NM · 3 h',
    points: [
        { lat: -27.47, lon: 153.02 },
        { lat: -27.1, lon: 153.4 },
    ],
    bbox: [153.02, -27.47, 153.4, -27.1],
    timestamp: 1_753_219_200_000,
    distanceNm: 18,
    isLocal: false,
    kind: 'sea',
};
const libraryRoute = {
    source: 'saved-trace',
    key: 'saved:moreton',
    routeId: 'moreton',
    label: route.label,
    points: route.points,
    timestamp: route.timestamp,
};
const trackChoice = {
    voyageId: 'voyage-hamilton',
    label: 'Daydream Island → Hamilton Island',
    sublabel: '25 Sep · 11 NM',
    timestamp: route.timestamp,
    distanceNm: 11,
    isLocal: false,
};

function props(overrides: Partial<React.ComponentProps<typeof RouteTrackPicker>> = {}) {
    return {
        visible: true,
        variant: 'route' as const,
        selectedId: null,
        onSelect: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('picker-owner');
    loadSavedRouteLibrary.mockResolvedValue([libraryRoute]);
    fetchSeaVoyageChoices.mockResolvedValue([trackChoice]);
    fetchVoyageAsTrack.mockResolvedValue({ ...route, id: trackChoice.voyageId });
});

describe('RouteTrackPicker', () => {
    it('loads and selects a saved route from an accessible modal', async () => {
        const input = props();
        render(<RouteTrackPicker {...input} />);

        const dialog = screen.getByRole('dialog', { name: 'Routes picker' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog.closest('[data-overlay-layer="modal"]')?.parentElement).toBe(document.body);
        await screen.findByRole('button', { name: /Brisbane to Moreton/ });
        fireEvent.click(screen.getByRole('button', { name: /Brisbane to Moreton/ }));

        expect(input.onSelect).toHaveBeenCalledWith(
            expect.objectContaining({
                id: libraryRoute.key,
                savedRouteId: libraryRoute.routeId,
                points: route.points,
            }),
        );
        expect(input.onClose).toHaveBeenCalledOnce();
        expect(triggerHaptic).toHaveBeenCalledWith('light');
    });

    it('offers a retry instead of leaving a failed fetch as an empty sheet', async () => {
        loadSavedRouteLibrary.mockRejectedValueOnce(new Error('offline'));
        const input = props();
        render(<RouteTrackPicker {...input} />);

        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load routes right now");
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(loadSavedRouteLibrary).toHaveBeenCalledTimes(2));
        expect(await screen.findByRole('button', { name: /Brisbane to Moreton/ })).toBeInTheDocument();
    });

    it('shows local Plan routes while account sync is still pending', async () => {
        loadSavedRouteLibrary.mockImplementationOnce((_scope, onCanonical) => {
            onCanonical([libraryRoute]);
            return new Promise(() => undefined);
        });
        render(<RouteTrackPicker {...props()} />);
        expect(await screen.findByRole('button', { name: /Brisbane to Moreton/ })).toBeEnabled();
        expect(screen.getByText(/reusable after sailing/)).toBeInTheDocument();
    });

    it('lists named history, keeps date/distance, and loads full track only when chosen', async () => {
        const input = props({ variant: 'track' });
        render(<RouteTrackPicker {...input} />);
        const button = await screen.findByRole('button', { name: /Daydream Island → Hamilton Island/ });
        expect(button).toHaveTextContent('25 Sep · 11 NM');
        expect(fetchVoyageAsTrack).not.toHaveBeenCalled();
        expect(loadSavedRouteLibrary).not.toHaveBeenCalled();
        fireEvent.click(button);
        await waitFor(() =>
            expect(input.onSelect).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: trackChoice.voyageId,
                    label: trackChoice.label,
                    points: route.points,
                }),
            ),
        );
        expect(fetchVoyageAsTrack).toHaveBeenCalledWith(trackChoice.voyageId);
        expect(input.onClose).toHaveBeenCalledOnce();
    });

    it('allows older history to be requested without a GPS-entry window', async () => {
        fetchSeaVoyageChoices.mockResolvedValueOnce(
            Array.from({ length: 20 }, (_, index) => ({
                ...trackChoice,
                voyageId: `voyage-${index}`,
            })),
        );
        render(<RouteTrackPicker {...props({ variant: 'track' })} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Show older tracks' }));
        await waitFor(() => expect(fetchSeaVoyageChoices).toHaveBeenLastCalledWith(40, expect.any(Function)));
    });

    it('does not select a late track after the picker closes', async () => {
        let resolve!: (track: RouteOrTrack) => void;
        fetchVoyageAsTrack.mockReturnValueOnce(
            new Promise<RouteOrTrack>((done) => {
                resolve = done;
            }),
        );
        const input = props({ variant: 'track' });
        const { rerender } = render(<RouteTrackPicker {...input} />);
        fireEvent.click(await screen.findByRole('button', { name: /Daydream Island/ }));
        rerender(<RouteTrackPicker {...input} visible={false} />);
        await act(async () => {
            resolve(route);
        });
        expect(input.onSelect).not.toHaveBeenCalled();
    });

    it('drops old-account canonical callbacks and reopens on the new identity', async () => {
        let oldCallback!: (routes: (typeof libraryRoute)[]) => void;
        loadSavedRouteLibrary
            .mockImplementationOnce((_scope, callback) => {
                oldCallback = callback;
                return new Promise(() => undefined);
            })
            .mockResolvedValueOnce([]);
        render(<RouteTrackPicker {...props()} />);
        await waitFor(() => expect(loadSavedRouteLibrary).toHaveBeenCalledOnce());
        await act(async () => {
            setAuthIdentityScope('different-picker-owner');
        });
        await act(async () => {
            oldCallback([libraryRoute]);
        });
        expect(screen.queryByRole('button', { name: /Brisbane to Moreton/ })).not.toBeInTheDocument();
        expect(await screen.findByText(/No saved routes yet/)).toBeInTheDocument();
    });

    it('keeps focus inside the dialog and restores the opener on close', async () => {
        const input = props({ visible: false, selectedId: route.id });
        const { rerender } = render(
            <>
                <button>Open routes</button>
                <RouteTrackPicker {...input} />
            </>,
        );
        const trigger = screen.getByRole('button', { name: 'Open routes' });
        trigger.focus();

        rerender(
            <>
                <button>Open routes</button>
                <RouteTrackPicker {...input} visible />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close picker' });
        const clear = await screen.findByRole('button', { name: 'Clear selection' });
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(clear).toHaveFocus();
        fireEvent.keyDown(clear, { key: 'Tab' });
        expect(close).toHaveFocus();

        rerender(
            <>
                <button>Open routes</button>
                <RouteTrackPicker {...input} />
            </>,
        );
        expect(trigger).toHaveFocus();
    });
});
