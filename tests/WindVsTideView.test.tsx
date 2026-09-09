import React from 'react';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WindVsTideView } from '../components/dashboard/tide/WindVsTideView';
import type { HourlyForecast } from '../types';

type Props = React.ComponentProps<typeof WindVsTideView>;
const NOW_MS = Date.parse('2026-09-09T02:00:00Z');
const atHour = (hour: number) => new Date(NOW_MS + hour * 3_600_000).toISOString();

function props(overrides: Partial<Props> = {}): Props {
    return {
        now: { windDeg: 45, windKts: 6, currentDir: 'NE', currentKts: 0 },
        nowMs: NOW_MS,
        tideSeries: Array.from({ length: 15 }, (_, hour) => ({ time: atHour(hour), height: 1 + hour * 0.1 })),
        hourly: [
            [3, 45],
            [6, 225],
            [9, 135],
            [12, 45],
        ].map(
            ([hour, windDegree]): HourlyForecast => ({
                time: atHour(hour),
                windDegree,
                windSpeed: 6,
                currentDirection: 45,
                currentSpeed: 0,
                waveHeight: 0.1,
                temperature: 22,
                condition: 'Clear',
            }),
        ),
        units: { speed: 'kts', length: 'm', waveHeight: 'm', temp: 'C', distance: 'nm' },
        onSetFloodDirection: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
}

describe('WindVsTideView detail content and controls', () => {
    it('keeps the current readout and every outlook relationship in the focusable details region', () => {
        render(<WindVsTideView {...props()} />);

        const details = screen.getByRole('region', { name: 'Wind versus tide details' });
        expect(details).toHaveAttribute('tabindex', '0');
        expect(screen.getByText('Wind against the stream')).toBeInTheDocument();
        expect(within(details).getByText('6 kts', { exact: false })).toHaveTextContent('6 kts from NE');
        expect(within(details).getByText('0 kts', { exact: false })).toHaveTextContent('0 kts to NE');
        for (const [hour, relationship] of [
            [3, 'against'],
            [6, 'with'],
            [9, 'cross'],
            [12, 'against'],
        ] as const) {
            const outlook = within(details).getByTestId(`wind-tide-outlook-${hour}`);
            expect(within(outlook).getByText(`+${hour}h`)).toBeInTheDocument();
            expect(within(outlook).getByText(relationship)).toBeInTheDocument();
        }
        expect(within(details).getByText('Stream from modelled current')).toBeInTheDocument();
        expect(within(details).getByRole('button', { name: 'Flood direction minus 15 degrees' })).toBeEnabled();
        expect(within(details).getByRole('button', { name: 'Flood direction plus 15 degrees' })).toBeEnabled();
        expect(screen.queryByRole('button', { name: 'Use modelled current instead' })).not.toBeInTheDocument();
    });

    it('keeps the close control outside the scrolling details', () => {
        const onClose = vi.fn();
        render(<WindVsTideView {...props({ onClose })} />);

        const details = screen.getByRole('region', { name: 'Wind versus tide details' });
        const close = screen.getByRole('button', { name: 'Back to tide graph' });
        expect(details).not.toContainElement(close);
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
        render(<WindVsTideView {...props({ now: {}, hourly: undefined })} />);
        expect(screen.getByText('Stream direction unavailable')).toBeInTheDocument();
        for (const hour of [3, 6, 9, 12]) {
            expect(within(screen.getByTestId(`wind-tide-outlook-${hour}`)).getByText('—')).toBeInTheDocument();
        }
    });
});

describe('WindVsTideView nested carousel keyboard isolation', () => {
    it.each(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'])(
        '%s stays inside details without preventing native scrolling',
        (key) => {
            const onAncestorKeyDown = vi.fn();
            render(
                <div onKeyDown={onAncestorKeyDown}>
                    <WindVsTideView {...props()} />
                </div>,
            );
            const details = screen.getByRole('region', { name: 'Wind versus tide details' });
            // A focused footer button must be protected just as the scroller
            // itself is: these events normally bubble to both carousels.
            for (const target of [details, screen.getByRole('button', { name: 'Flood direction plus 15 degrees' })]) {
                const event = createEvent.keyDown(target, { key, bubbles: true, cancelable: true });
                fireEvent(target, event);
                expect(event.defaultPrevented).toBe(false);
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
        const event = createEvent.keyDown(details, { key: 'Tab', bubbles: true, cancelable: true });
        fireEvent(details, event);
        expect(event.defaultPrevented).toBe(false);
        expect(onAncestorKeyDown).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole('button', { name: 'Flood direction plus 15 degrees' }));
        expect(options.onSetFloodDirection).toHaveBeenCalledWith(60);
    });
});
