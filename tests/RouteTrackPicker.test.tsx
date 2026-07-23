import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteTrackPicker } from '../components/map/RouteTrackPicker';
import type { RouteOrTrack } from '../services/shiplog/RoutesAndTracks';

const fetchRoutesAndTracks = vi.hoisted(() => vi.fn());
const triggerHaptic = vi.hoisted(() => vi.fn());

vi.mock('../services/shiplog/RoutesAndTracks', () => ({ fetchRoutesAndTracks }));
vi.mock('../utils/system', () => ({ triggerHaptic }));
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
    fetchRoutesAndTracks.mockResolvedValue({ routes: [route], tracks: [] });
});

describe('RouteTrackPicker', () => {
    it('loads and selects a saved route from an accessible modal', async () => {
        const input = props();
        render(<RouteTrackPicker {...input} />);

        expect(screen.getByRole('dialog', { name: 'Routes picker' })).toHaveAttribute('aria-modal', 'true');
        await screen.findByRole('button', { name: /Brisbane to Moreton/ });
        fireEvent.click(screen.getByRole('button', { name: /Brisbane to Moreton/ }));

        expect(input.onSelect).toHaveBeenCalledWith(route);
        expect(input.onClose).toHaveBeenCalledOnce();
        expect(triggerHaptic).toHaveBeenCalledWith('light');
    });

    it('offers a retry instead of leaving a failed fetch as an empty sheet', async () => {
        fetchRoutesAndTracks.mockRejectedValueOnce(new Error('offline'));
        const input = props();
        render(<RouteTrackPicker {...input} />);

        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load routes right now");
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(fetchRoutesAndTracks).toHaveBeenCalledTimes(2));
        expect(await screen.findByRole('button', { name: /Brisbane to Moreton/ })).toBeInTheDocument();
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
