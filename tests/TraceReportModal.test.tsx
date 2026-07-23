import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TraceReportModal } from '../components/map/TraceReportModal';
import type { TraceLegVerdict } from '../services/routeTracer';

const triggerHaptic = vi.hoisted(() => vi.fn());
const fetchRouteWaypointWeather = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('../utils/system', () => ({ triggerHaptic }));
vi.mock('../services/routeReportWeather', () => ({
    windCompass: () => 'N',
    fetchRouteWaypointWeather,
}));

const pins = [
    { lat: -27.471, lon: 153.024 },
    { lat: -27.57, lon: 153.1 },
];

const danger: TraceLegVerdict = {
    grade: 'danger',
    issues: [{ severity: 'danger', message: 'Shallow water ahead' }],
    minDepthM: 1.2,
    minAt: pins[1],
    needsTide: true,
    nudge: null,
    nudgeTo: null,
};

function props(overrides: Partial<React.ComponentProps<typeof TraceReportModal>> = {}) {
    return {
        open: true,
        onClose: vi.fn(),
        pins,
        routeName: 'Brisbane to Moreton',
        verdicts: [danger],
        tideLabels: { 0: 'Wait for the rising tide' },
        departureLabel: 'Leave at 09:10',
        ackedLegs: new Set<number>(),
        fixBusy: null,
        onFlyTo: vi.fn(),
        onFixLeg: vi.fn(),
        onFixAll: vi.fn(),
        onAckLeg: vi.fn(),
        ...overrides,
    };
}

describe('TraceReportModal', () => {
    it('is absent while closed', () => {
        const { container } = render(<TraceReportModal {...props({ open: false })} />);

        expect(container).toBeEmptyDOMElement();
    });

    it('exposes an accessible modal and its route-safety actions', () => {
        const input = props();
        render(<TraceReportModal {...input} />);

        expect(screen.getByRole('dialog', { name: 'Route report' })).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByText('Brisbane to Moreton')).toBeInTheDocument();
        expect(screen.getByText('Shallow water ahead')).toBeInTheDocument();
        expect(screen.getByText(/Wait for the rising tide/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
        expect(input.onFixLeg).toHaveBeenCalledWith(0);

        fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
        expect(input.onAckLeg).toHaveBeenCalledWith(0);

        fireEvent.click(screen.getByRole('button', { name: 'Fix all 1 no-go leg' }));
        expect(input.onFixAll).toHaveBeenCalledOnce();
    });

    it('closes via either the visible control or Escape', () => {
        const input = props();
        render(<TraceReportModal {...input} />);

        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

        expect(input.onClose).toHaveBeenCalledTimes(2);
    });

    it('keeps keyboard focus inside the modal and restores it on close', () => {
        const input = props({ open: false });
        const { rerender } = render(
            <>
                <button>Open report</button>
                <TraceReportModal {...input} />
            </>,
        );
        const trigger = screen.getByRole('button', { name: 'Open report' });
        trigger.focus();

        rerender(
            <>
                <button>Open report</button>
                <TraceReportModal {...input} open />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close' });
        const firstControl = screen.getByRole('button', { name: /GPX/ });
        const fixAll = screen.getByRole('button', { name: 'Fix all 1 no-go leg' });
        expect(close).toHaveFocus();

        firstControl.focus();
        fireEvent.keyDown(firstControl, { key: 'Tab', shiftKey: true });
        expect(fixAll).toHaveFocus();
        fireEvent.keyDown(fixAll, { key: 'Tab' });
        expect(firstControl).toHaveFocus();

        rerender(
            <>
                <button>Open report</button>
                <TraceReportModal {...input} />
            </>,
        );
        expect(trigger).toHaveFocus();
    });
});
