import React from 'react';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WindVsTideView } from '../components/dashboard/tide/WindVsTideView';

type Props = React.ComponentProps<typeof WindVsTideView>;
const NOW_MS = Date.parse('2026-09-09T02:00:00Z');
const atHour = (hour: number) => new Date(NOW_MS + hour * 3_600_000).toISOString();

function props(overrides: Partial<Props> = {}): Props {
    return {
        now: { windDeg: 45, windKts: 6, currentDir: 'NE', currentKts: 0 },
        nowMs: NOW_MS,
        tideSeries: Array.from({ length: 15 }, (_, hour) => ({ time: atHour(hour), height: 1 + hour * 0.1 })),
        units: { speed: 'kts', length: 'm', waveHeight: 'm', temp: 'C', distance: 'nm' },
        onSetFloodDirection: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
}

describe('WindVsTideView detail content and controls', () => {
    it('keeps the current readout and controls in a focusable region without an outlook or scrolling affordances', () => {
        render(<WindVsTideView {...props()} />);

        const details = screen.getByRole('region', { name: 'Wind versus tide details' });
        expect(details).toHaveAttribute('tabindex', '0');
        expect(screen.getByText('Wind against the stream')).toBeInTheDocument();
        expect(details).toHaveAccessibleDescription('Wind against the stream');
        expect(within(details).getByText('6 kts', { exact: false })).toHaveTextContent('6 kts from NE');
        expect(within(details).getByText('0 kts', { exact: false })).toHaveTextContent('0 kts to NE');
        expect(screen.queryByText(/^\+\d+h$/)).not.toBeInTheDocument();
        expect(screen.queryByTestId(/^wind-tide-outlook-/)).not.toBeInTheDocument();
        expect(screen.queryByText(/More below|Scroll up/)).not.toBeInTheDocument();
        expect(details).not.toHaveClass('overflow-y-auto');
        expect(details).not.toHaveClass('overflow-y-scroll');
        expect(within(details).getByText('Stream from modelled current')).toBeInTheDocument();
        expect(within(details).getByRole('button', { name: 'Flood direction minus 15 degrees' })).toBeEnabled();
        expect(within(details).getByRole('button', { name: 'Flood direction plus 15 degrees' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: 'Use modelled current instead' })).not.toBeInTheDocument();
    });

    it('keeps the close control accessible and returns to the tide graph', () => {
        const onClose = vi.fn();
        render(<WindVsTideView {...props({ onClose })} />);

        const close = screen.getByRole('button', { name: 'Back to tide graph' });
        expect(close).toBeEnabled();
        fireEvent.click(close);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('starts adjustments from the modelled direction and never closes the face', () => {
        const options = props();
        render(<WindVsTideView {...options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Flood direction minus 15 degrees' }));
        fireEvent.click(screen.getByRole('button', { name: 'Flood direction plus 15 degrees' }));
        expect(options.onSetFloodDirection).toHaveBeenNthCalledWith(1, 30);
        expect(options.onSetFloodDirection).toHaveBeenNthCalledWith(2, 60);
        expect(options.onClose).not.toHaveBeenCalled();
    });

    it('preserves wrapping, controlled updates and the return to modelled current', () => {
        const options = props({ floodDirection: 0 });
        const { rerender } = render(<WindVsTideView {...options} />);

        fireEvent.click(screen.getByRole('button', { name: 'Flood direction minus 15 degrees' }));
        expect(options.onSetFloodDirection).toHaveBeenLastCalledWith(345);

        rerender(<WindVsTideView {...options} floodDirection={345} />);
        expect(screen.getByText('Stream from your flood 345°')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Flood direction plus 15 degrees' }));
        expect(options.onSetFloodDirection).toHaveBeenLastCalledWith(0);

        fireEvent.click(screen.getByRole('button', { name: 'Use modelled current instead' }));
        expect(options.onSetFloodDirection).toHaveBeenLastCalledWith(undefined);
        rerender(<WindVsTideView {...options} floodDirection={undefined} />);
        expect(screen.getByText('Stream from modelled current')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Use modelled current instead' })).not.toBeInTheDocument();
        expect(options.onClose).not.toHaveBeenCalled();
    });

    it('keeps missing instrument directions explicitly unavailable', () => {
        render(<WindVsTideView {...props({ now: {} })} />);
        expect(screen.getByText('Stream direction unavailable')).toBeInTheDocument();
        expect(screen.getByText('from --')).toBeInTheDocument();
        expect(screen.getByText('to --')).toBeInTheDocument();
    });
});

describe('WindVsTideView nested carousel keyboard isolation', () => {
    it.each(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'])(
        '%s cannot move the surrounding carousel or scroll its ancestors',
        (key) => {
            const onAncestorKeyDown = vi.fn();
            render(
                <div onKeyDown={onAncestorKeyDown}>
                    <WindVsTideView {...props()} />
                </div>,
            );
            const details = screen.getByRole('region', { name: 'Wind versus tide details' });
            // The region and its focused controls must both isolate the keys
            // handled by the surrounding carousels and scroll containers.
            for (const target of [details, screen.getByRole('button', { name: 'Flood direction plus 15 degrees' })]) {
                const event = createEvent.keyDown(target, { key, bubbles: true, cancelable: true });
                fireEvent(target, event);
                expect(event.defaultPrevented).toBe(true);
            }
            expect(onAncestorKeyDown).not.toHaveBeenCalled();
        },
    );

    it('does not trap Tab or suppress normal button activation', () => {
        const onAncestorKeyDown = vi.fn();
        const options = props();
        render(
            <div onKeyDown={onAncestorKeyDown}>
                <WindVsTideView {...options} />
            </div>,
        );
        const details = screen.getByRole('region', { name: 'Wind versus tide details' });
        const increase = screen.getByRole('button', { name: 'Flood direction plus 15 degrees' });
        for (const [target, key] of [
            [details, 'Tab'],
            [increase, 'Enter'],
            [increase, ' '],
        ] as const) {
            const event = createEvent.keyDown(target, { key, bubbles: true, cancelable: true });
            fireEvent(target, event);
            expect(event.defaultPrevented).toBe(false);
        }
        expect(onAncestorKeyDown).toHaveBeenCalledTimes(3);
        fireEvent.click(increase);
        expect(options.onSetFloodDirection).toHaveBeenCalledWith(60);
    });
});
