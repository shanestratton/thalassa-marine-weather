import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TopNav from '../src/components/TopNav';
import { TelemetryPanel } from '../src/components/TelemetryPanel';
import { PUBLIC_POSITION_FRESH_MS } from '../src/publicVoyageFreshness';
import type { VoyageLogTelemetry } from '../src/voyageLogApi';

const NOW = Date.parse('2026-08-04T10:00:00.000Z');

function telemetry(updatedAt = new Date(NOW).toISOString()): VoyageLogTelemetry {
    return {
        sog: 6.2,
        cog: 90,
        heading: 91,
        baro: 1012,
        baro_trend: 'steady',
        aws: 12,
        awa: 45,
        tws: 10,
        twd: 120,
        depth: 20,
        air_temp: 25,
        water_temp: 24,
        wave_height: 1,
        lat: -27,
        lon: 153,
        updated_at: updatedAt,
        is_last_known: false,
    };
}

const vessel = { name: 'Calypso', type: 'sail', model: 'Beneteau' };

describe('public voyage status honesty', () => {
    it('ages TopNav out of Live without requiring a new payload', () => {
        const t = telemetry();
        const { rerender } = render(
            <TopNav
                vessel={vessel}
                telemetry={t}
                entryCount={2}
                nowMs={NOW}
                connectionLost={false}
                lastSuccessfulAt={NOW}
            />,
        );
        expect(screen.getByText('Live · just now')).toBeInTheDocument();

        rerender(
            <TopNav
                vessel={vessel}
                telemetry={t}
                entryCount={2}
                nowMs={NOW + PUBLIC_POSITION_FRESH_MS}
                connectionLost={false}
                lastSuccessfulAt={NOW}
            />,
        );
        expect(screen.getByText('Not tracking · 10 min ago')).toBeInTheDocument();
        expect(screen.queryByText(/Live ·/)).not.toBeInTheDocument();
    });

    it('gives poll failure precedence over cached telemetry and advances last-success age', () => {
        render(
            <TopNav
                vessel={vessel}
                telemetry={telemetry()}
                entryCount={2}
                nowMs={NOW + 2 * 60_000}
                connectionLost
                lastSuccessfulAt={NOW}
            />,
        );

        expect(screen.getByRole('status')).toHaveTextContent('Connection lost · last update 2 min ago');
        expect(screen.queryByText(/Live ·/)).not.toBeInTheDocument();
    });

    it('removes live instruments on connection loss and labels retained data', () => {
        const { rerender } = render(
            <TelemetryPanel telemetry={telemetry()} nowMs={NOW} connectionLost={false} lastSuccessfulAt={NOW} />,
        );
        expect(screen.getByText('Live')).toBeInTheDocument();

        rerender(
            <TelemetryPanel telemetry={telemetry()} nowMs={NOW + 2 * 60_000} connectionLost lastSuccessfulAt={NOW} />,
        );
        expect(screen.getByRole('status')).toHaveTextContent('Connection lost');
        expect(screen.getByRole('status')).toHaveTextContent('Showing last-known voyage data · last update 2 min ago');
        expect(screen.queryByText('Live')).not.toBeInTheDocument();
    });
});
