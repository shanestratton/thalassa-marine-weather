/**
 * MapActionFabs — GPS locate, weather recenter and one-handed zoom tests.
 */
import React from 'react';
import type mapboxgl from 'mapbox-gl';
import { act, cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { MapActionFabs } from '../components/map/MapActionFabs';
import { registerChartMap } from '../components/map/chartMapRegistry';

describe('MapActionFabs', () => {
    const defaultProps = {
        onLocateMe: vi.fn(),
        onRecenter: vi.fn(),
        recenterDisabled: false,
    };

    it('renders the GPS action and keeps the parked recenter action hidden', () => {
        render(<MapActionFabs {...defaultProps} />);
        expect(screen.getByLabelText('Locate me')).toBeInTheDocument();
        expect(screen.queryByLabelText('Recenter on weather location')).not.toBeInTheDocument();
    });

    it('calls onLocateMe when GPS button is clicked', () => {
        const onLocateMe = vi.fn();
        render(<MapActionFabs {...defaultProps} onLocateMe={onLocateMe} />);
        fireEvent.click(screen.getByLabelText('Locate me'));
        expect(onLocateMe).toHaveBeenCalledTimes(1);
    });

    // Shane 2026-10-08: Locate goes to the phone on Current Location and to
    // the boat on hers; the button now draws which, and says it to VoiceOver.
    it('draws the phone it goes to on Current Location, and says so', () => {
        render(<MapActionFabs {...defaultProps} target="phone" />);
        const button = screen.getByRole('button', { name: 'Locate me' });
        expect(button.querySelector('svg[data-glyph="phone"]')).not.toBeNull();
        expect(button.querySelector('svg[data-glyph="crosshair"]')).toBeNull();
        expect(button).toHaveAccessibleDescription('Goes to your phone');
    });

    it('keeps the crosshair for the boat, and says so', () => {
        render(<MapActionFabs {...defaultProps} target="boat" />);
        const button = screen.getByRole('button', { name: 'Locate me' });
        expect(button.querySelector('svg[data-glyph="crosshair"]')).not.toBeNull();
        expect(button.querySelector('svg[data-glyph="phone"]')).toBeNull();
        expect(button).toHaveAccessibleDescription('Goes to the boat');
    });

    it('with no target, the crosshair and no description, as before', () => {
        render(<MapActionFabs {...defaultProps} />);
        const button = screen.getByRole('button', { name: 'Locate me' });
        expect(button.querySelector('svg[data-glyph="crosshair"]')).not.toBeNull();
        expect(button).not.toHaveAttribute('aria-describedby');
    });

    it('positions at the bottom with safe area inset', () => {
        const { container } = render(<MapActionFabs {...defaultProps} />);
        const wrapper = container.firstChild as HTMLElement;
        expect(wrapper.style.bottom).toContain('calc(80px');
    });
});

// ── One-handed zoom and Locate feedback (UX scorecard run 7) ──────────────
function fakeMap(zoom = 8) {
    const listeners = new Map<string, Set<(event?: unknown) => void>>();
    const map = {
        zoom,
        on: vi.fn((name: string, listener: (event?: unknown) => void) => {
            const set = listeners.get(name) ?? new Set();
            set.add(listener);
            listeners.set(name, set);
        }),
        off: vi.fn((name: string, listener: (event?: unknown) => void) => {
            listeners.get(name)?.delete(listener);
        }),
        emit(name: string, event?: unknown) {
            [...(listeners.get(name) ?? [])].forEach((listener) => listener(event));
        },
        getZoom: () => map.zoom,
        getMinZoom: () => 3,
        getMaxZoom: () => 22,
        zoomIn: vi.fn(),
        zoomOut: vi.fn(),
    };
    return map;
}

function renderBesideMap(props: Partial<React.ComponentProps<typeof MapActionFabs>> = {}, zoom = 8) {
    const map = fakeMap(zoom);
    const view = render(
        <div>
            <div className="mapboxgl-map" data-testid="chart" />
            <MapActionFabs onLocateMe={vi.fn()} onRecenter={vi.fn()} recenterDisabled={false} {...props} />
        </div>,
    );
    // Registered after mount, as on device: the parent's map effect runs last.
    let release = () => {};
    act(() => {
        release = registerChartMap(screen.getByTestId('chart'), map as unknown as mapboxgl.Map);
    });
    return { ...view, map, release };
}

describe('MapActionFabs zoom', () => {
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('zooms the chart beside it one step, as the skipper’s own camera move', () => {
        const { map, release } = renderBesideMap();
        fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
        expect(map.zoomIn).toHaveBeenCalledOnce();
        expect(map.zoomIn.mock.calls[0][1]).toHaveProperty('originalEvent');
        fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
        expect(map.zoomOut).toHaveBeenCalledOnce();
        release();
    });

    it('greys out zoom-out at the chart’s minimum zoom', () => {
        const { map, release } = renderBesideMap({}, 3);
        expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
        map.zoom = 5;
        act(() => map.emit('zoomend'));
        expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
        release();
    });

    it('is a named group with 48 px buttons, never under 44 px, on the right rail', () => {
        const { release } = renderBesideMap();
        const group = screen.getByRole('group', { name: 'Map zoom' });
        // Up the right rail above the credits in portrait; the middle-left rail
        // in short landscape, which the ENC notice reserves (UX scorecard run 7).
        expect(group.className).toContain('right-[max(16px,env(safe-area-inset-right))]');
        expect(group.className).toContain('bottom-[calc(242px+env(safe-area-inset-bottom))]');
        expect(group.className).toContain(
            '[@media(orientation:landscape)_and_(max-height:600px)]:left-[max(16px,env(safe-area-inset-left))]',
        );
        expect(group.className).toContain('[@media(orientation:landscape)_and_(max-height:600px)]:top-1/2');
        // 3rem is 48 px at the usual root font but 39 px on a 320 pt phone
        // (13 px root), so each button is floored at 44 px.
        for (const button of within(group).getAllByRole('button'))
            expect(button.className).toContain('h-[max(44px,3rem)] w-[max(44px,3rem)]');
        release();
    });
});

describe('MapActionFabs locate feedback', () => {
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('answers the tap at once and announces the centred chart', () => {
        let mapRef: ReturnType<typeof fakeMap> | null = null;
        const { map, release } = renderBesideMap({
            // A live boat fix: the flight starts inside the handler itself.
            onLocateMe: () => mapRef?.emit('movestart', {}),
        });
        mapRef = map;
        fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));
        expect(screen.getByRole('status')).toHaveTextContent('Chart centred on your position.');
        expect(screen.getByRole('button', { name: 'Locate me' })).toHaveAttribute('aria-busy', 'false');
        release();
    });

    it('says so when no fix arrives, and ignores the skipper panning meanwhile', () => {
        vi.useFakeTimers();
        const { map, release } = renderBesideMap();
        fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));
        expect(screen.getByRole('button', { name: 'Locate me' })).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByRole('status')).toHaveTextContent('Finding your position…');
        // Said on screen as well, in the slot the failure takes (UX scorecard run 8).
        expect(screen.getByText('Finding position…')).toBeInTheDocument();
        act(() => map.emit('movestart', { originalEvent: new Event('touchstart') }));
        expect(screen.getByRole('status')).toHaveTextContent('Finding your position…');
        act(() => {
            vi.advanceTimersByTime(11_000);
        });
        expect(screen.queryByText('Finding position…')).not.toBeInTheDocument();
        expect(screen.getByText('No position fix')).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('No position fix. The chart has not moved.');
        // A slow permission answer still lands, and clears the notice.
        act(() => map.emit('movestart', {}));
        expect(screen.queryByText('No position fix')).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('Chart centred on your position.');
        release();
    });

    // Locate on Obs answers with what it did (obsCentre.locateOnObs).
    it('ends the search on the handler’s answer and says its words', async () => {
        vi.useFakeTimers();
        let mapRef: ReturnType<typeof fakeMap> | null = null;
        let answer!: (result: { centred: boolean; announcement: string }) => void;
        const { map, release } = renderBesideMap({
            onLocateMe: () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        });
        mapRef = map;
        fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));
        expect(screen.getByText('Finding position…')).toBeInTheDocument();
        // The flight starts before the answer lands: its words, not the phone's.
        act(() => mapRef?.emit('movestart', {}));
        expect(screen.getByRole('status')).toHaveTextContent('Finding your position…');
        await act(async () => answer({ centred: true, announcement: 'Chart centred on Serene Summer.' }));
        expect(screen.queryByText('Finding position…')).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('Chart centred on Serene Summer.');
        expect(screen.getByRole('button', { name: 'Locate me' })).toHaveAttribute('aria-busy', 'false');
        // Answered: the 11 s no-fix notice never comes.
        act(() => vi.advanceTimersByTime(12_000));
        expect(screen.queryByText('No position fix')).not.toBeInTheDocument();
        release();
    });

    it('a "no boat position" answer leaves the speaking to the chart’s message', async () => {
        vi.useFakeTimers();
        const { release } = renderBesideMap({
            onLocateMe: () => Promise.resolve({ centred: false, announcement: '' }),
        });
        fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));
        await act(async () => {});
        expect(screen.queryByText('Finding position…')).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('');
        act(() => vi.advanceTimersByTime(12_000));
        expect(screen.queryByText('No position fix')).not.toBeInTheDocument();
        release();
    });

    // Nothing found while the chart's message is about something else
    // (review 2026-10-06): the button says so itself, on screen too.
    it('a "no fix" answer shows and says its own words, then goes', async () => {
        vi.useFakeTimers();
        const { release } = renderBesideMap({
            onLocateMe: () =>
                Promise.resolve({
                    centred: false,
                    announcement: 'No position from Serene Summer yet. The chart has not moved.',
                    noFix: true,
                }),
        });
        fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));
        await act(async () => {});
        expect(screen.queryByText('Finding position…')).not.toBeInTheDocument();
        expect(screen.getByText('No position fix')).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent(
            'No position from Serene Summer yet. The chart has not moved.',
        );
        act(() => vi.advanceTimersByTime(5_000));
        expect(screen.queryByText('No position fix')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Locate me' })).toHaveAttribute('aria-busy', 'false');
        release();
    });

    it('a superseded tap’s answer changes nothing', async () => {
        vi.useFakeTimers();
        const answers: Array<(result: { centred: boolean; announcement: string } | null) => void> = [];
        const { release } = renderBesideMap({
            onLocateMe: () => new Promise((resolve) => answers.push(resolve)),
        });
        const button = screen.getByRole('button', { name: 'Locate me' });
        fireEvent.click(button);
        fireEvent.click(button);
        await act(async () => answers[0](null));
        expect(screen.getByText('Finding position…')).toBeInTheDocument();
        await act(async () => answers[1]({ centred: true, announcement: 'Chart centred on your boat.' }));
        expect(screen.getByRole('status')).toHaveTextContent('Chart centred on your boat.');
        release();
    });

    it('still calls onLocateMe when no map is registered', () => {
        const onLocateMe = vi.fn();
        render(<MapActionFabs onLocateMe={onLocateMe} onRecenter={vi.fn()} recenterDisabled={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));
        expect(onLocateMe).toHaveBeenCalledOnce();
    });
});

// ── A chosen place (126-18) ───────────────────────────────────────────────
// Shane 2026-10-09: "if it isnt the vessel location or the phone location,
// can we have a pin in the location and that is where the locate fab goes to
// on the obs page". The button draws where the NEXT tap goes, and a small
// label says where the last one went. Fictional places.
describe('MapActionFabs, a chosen place', () => {
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('draws a pin and says the place it goes to', () => {
        render(
            <MapActionFabs
                onLocateMe={vi.fn()}
                onRecenter={vi.fn()}
                recenterDisabled={false}
                target="place"
                placeName="Port Kittiwake"
            />,
        );
        const button = screen.getByRole('button', { name: 'Locate me' });
        expect(button.querySelector('svg[data-glyph="place"]')).not.toBeNull();
        expect(button.querySelector('svg[data-glyph="crosshair"]')).toBeNull();
        expect(button.querySelector('svg[data-glyph="phone"]')).toBeNull();
        expect(button).toHaveAccessibleDescription('Goes to Port Kittiwake');
        expect(button).toHaveAttribute('data-target', 'place');
    });

    it('an answer with a label shows it for 3 s beside the button; the status says the answer’s words', async () => {
        vi.useFakeTimers();
        let mapRef: ReturnType<typeof fakeMap> | null = null;
        const { map, release } = renderBesideMap({
            target: 'place',
            placeName: 'Port Kittiwake',
            // locatePlace: the flight starts after a microtask, then the answer.
            onLocateMe: async () => {
                await Promise.resolve();
                mapRef?.emit('movestart', {});
                return { centred: true, announcement: 'Chart centred on Port Kittiwake.', label: 'Port Kittiwake' };
            },
        });
        mapRef = map;
        fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));
        await act(async () => {});
        const chip = screen.getByText('Port Kittiwake');
        expect(chip).toHaveAttribute('aria-hidden', 'true');
        expect(chip.className).toContain('truncate');
        expect(screen.queryByText('Finding position…')).not.toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('Chart centred on Port Kittiwake.');
        expect(screen.getByRole('status')).not.toHaveTextContent('Chart centred on your position.');
        act(() => vi.advanceTimersByTime(2_900));
        expect(screen.getByText('Port Kittiwake')).toBeInTheDocument();
        act(() => vi.advanceTimersByTime(200));
        expect(screen.queryByText('Port Kittiwake')).not.toBeInTheDocument();
        release();
    });

    it('a new tap takes the label down at once', async () => {
        vi.useFakeTimers();
        const answers: Array<(result: { centred: boolean; announcement: string; label?: string }) => void> = [];
        const { release } = renderBesideMap({
            onLocateMe: () => new Promise((resolve) => answers.push(resolve)),
        });
        const button = screen.getByRole('button', { name: 'Locate me' });
        fireEvent.click(button);
        await act(async () =>
            answers[0]({ centred: true, announcement: 'Chart centred on Kittiwake.', label: 'Kittiwake' }),
        );
        expect(screen.getByText('Kittiwake')).toBeInTheDocument();
        fireEvent.click(button);
        expect(screen.queryByText('Kittiwake')).not.toBeInTheDocument();
        expect(screen.getByText('Finding position…')).toBeInTheDocument();
        release();
    });

    it('an answer without a label: no new chip (every 124 flow looks the same)', async () => {
        vi.useFakeTimers();
        const { release, container } = renderBesideMap({
            target: 'boat',
            onLocateMe: () => Promise.resolve({ centred: true, announcement: 'Chart centred on Kittiwake.' }),
        });
        fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));
        await act(async () => {});
        expect(container.querySelector('[data-locate-label]')).toBeNull();
        expect(screen.getByRole('status')).toHaveTextContent('Chart centred on Kittiwake.');
        release();
    });

    it('a "no fix" answer keeps its own words on screen, never a label', async () => {
        vi.useFakeTimers();
        const { release, container } = renderBesideMap({
            onLocateMe: () =>
                Promise.resolve({
                    centred: false,
                    announcement: 'No position from Kittiwake yet. The chart has not moved.',
                    noFix: true,
                    label: 'Kittiwake',
                }),
        });
        fireEvent.click(screen.getByRole('button', { name: 'Locate me' }));
        await act(async () => {});
        expect(screen.getByText('No position fix')).toBeInTheDocument();
        expect(container.querySelector('[data-locate-label]')).toBeNull();
        release();
    });
});
