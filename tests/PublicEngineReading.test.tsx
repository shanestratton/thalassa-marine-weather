import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryPanel } from '../src/components/TelemetryPanel';
import { publicInstrumentSnapshot } from '../supabase/functions/_shared/public-instruments';

const now = Date.parse('2026-09-07T05:30:00Z');
const data = (rpm: number | null) =>
    publicInstrumentSnapshot(
        {
            boat_id: 'boat',
            reported_at: new Date(now).toISOString(),
            sog_kts: 0,
            rpm,
        },
        'boat',
        now,
    )!;
const engineCard = () => within(screen.getByText('Engine').parentElement!);
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('public engine status', () => {
    it('shows Engine off for reported zero without a dangling RPM unit', () => {
        render(<TelemetryPanel instruments={data(0)} nowMs={now} connectionLost={false} lastSuccessfulAt={now} />);
        expect(engineCard().getByText('Engine off')).toBeInTheDocument();
        expect(engineCard().queryByText('RPM')).not.toBeInTheDocument();
    });
    it.each([null, NaN, Infinity, -1])('does not call unavailable or invalid RPM %s an engine-off reading', (rpm) => {
        render(<TelemetryPanel instruments={data(rpm)} nowMs={now} connectionLost={false} lastSuccessfulAt={now} />);
        expect(engineCard().getByText('No RPM signal')).toBeInTheDocument();
        expect(engineCard().queryByText('Engine off')).not.toBeInTheDocument();
        expect(engineCard().queryByText('RPM')).not.toBeInTheDocument();
    });
    it('switches from off to the running RPM and then to signal unavailable', () => {
        const { rerender } = render(
            <TelemetryPanel instruments={data(0)} nowMs={now} connectionLost={false} lastSuccessfulAt={now} />,
        );
        rerender(<TelemetryPanel instruments={data(1800)} nowMs={now} connectionLost={false} lastSuccessfulAt={now} />);
        expect(engineCard().getByText('1800')).toBeInTheDocument();
        expect(engineCard().getByText('RPM')).toBeInTheDocument();
        expect(engineCard().queryByText('Engine off')).not.toBeInTheDocument();
        rerender(<TelemetryPanel instruments={data(null)} nowMs={now} connectionLost={false} lastSuccessfulAt={now} />);
        expect(engineCard().getByText('No RPM signal')).toBeInTheDocument();
    });
    it('withdraws Engine off when the connection is lost or the report expires', () => {
        const { rerender } = render(
            <TelemetryPanel instruments={data(0)} nowMs={now} connectionLost lastSuccessfulAt={now} />,
        );
        expect(screen.queryByText('Engine off')).not.toBeInTheDocument();
        rerender(
            <TelemetryPanel
                instruments={data(0)}
                nowMs={now + 600_000}
                connectionLost={false}
                lastSuccessfulAt={now}
            />,
        );
        expect(screen.queryByText('Engine off')).not.toBeInTheDocument();
    });
});
