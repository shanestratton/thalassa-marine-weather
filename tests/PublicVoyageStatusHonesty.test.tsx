import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TopNav from '../src/components/TopNav';
import { TelemetryPanel } from '../src/components/TelemetryPanel';
import DiarySidebar from '../src/components/DiarySidebar';
import { PUBLIC_POSITION_FRESH_MS } from '../src/publicVoyageFreshness';
import type { VoyageLogTelemetry, VoyageLogInstruments } from '../src/voyageLogApi';

const NOW = Date.parse('2026-08-04T10:00:00.000Z');

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function showBarometer() {
    fireEvent.click(screen.getByRole('button', { name: 'Barometer' }));
    expect(within(screen.getByRole('img', { name: 'Barometer' })).getByText('1012.0')).toBeInTheDocument();
}

function telemetry(updatedAt = new Date(NOW).toISOString()): VoyageLogTelemetry & VoyageLogInstruments {
    return {
        source: 'pi',
        stw: 5.9,
        twa: 50,
        voltage: 12.8,
        rpm: 0,
        heel: 2,
        pitch: 1,
        rudder: 0,
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

describe('instrument sharing visibility', () => {
    const sidebarProps = {
        entries: [],
        telemetry: null,
        instruments: telemetry(),
        nowMs: NOW,
        connectionLost: false,
        lastSuccessfulAt: NOW,
        selectedEntry: null,
        onSelectEntry: () => {},
        onClearSelection: () => {},
        onPhotoClick: () => {},
    };

    it('explains withheld sharing without rendering even a retained instrument snapshot', () => {
        render(<DiarySidebar {...sidebarProps} showTelemetry={false} showSharingNotice />);
        expect(screen.getByRole('region', { name: 'Instrument sharing status' })).toHaveTextContent(
            'Instruments aren’t currently being shared.',
        );
        expect(screen.getByText(/open the main Thalassa app/)).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Onboard instruments' })).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Choose instrument' })).not.toBeInTheDocument();
        expect(screen.queryByText('Live')).not.toBeInTheDocument();
    });

    it('replaces the explanation with readings only once the parent confirms sharing', () => {
        const { rerender } = render(<DiarySidebar {...sidebarProps} showTelemetry={false} showSharingNotice />);
        rerender(<DiarySidebar {...sidebarProps} showTelemetry showSharingNotice={false} />);
        expect(screen.queryByRole('region', { name: 'Instrument sharing status' })).not.toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Onboard instruments' })).toBeInTheDocument();
        expect(screen.getByRole('group', { name: 'Choose instrument' })).toBeInTheDocument();
        showBarometer();
    });

    it('withdraws previously displayed readings immediately when sharing is revoked', () => {
        const { rerender } = render(<DiarySidebar {...sidebarProps} showTelemetry showSharingNotice={false} />);
        showBarometer();
        // The retained snapshot is unchanged: consent, not data arrival, must hide it.
        rerender(<DiarySidebar {...sidebarProps} showTelemetry={false} showSharingNotice />);
        expect(screen.getByRole('region', { name: 'Instrument sharing status' })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Onboard instruments' })).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Choose instrument' })).not.toBeInTheDocument();
        expect(screen.queryByText('1012.0')).not.toBeInTheDocument();
        expect(screen.queryByText('Live')).not.toBeInTheDocument();
    });

    it('keeps historical views free of present-tense sharing notices and readings', () => {
        render(<DiarySidebar {...sidebarProps} showTelemetry={false} showSharingNotice={false} />);
        expect(screen.queryByRole('region', { name: 'Onboard instruments' })).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Instrument sharing status' })).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Choose instrument' })).not.toBeInTheDocument();
    });
});

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
            <TelemetryPanel instruments={telemetry()} nowMs={NOW} connectionLost={false} lastSuccessfulAt={NOW} />,
        );
        expect(screen.getByText('Live')).toBeInTheDocument();

        showBarometer();

        rerender(
            <TelemetryPanel instruments={telemetry()} nowMs={NOW + 2 * 60_000} connectionLost lastSuccessfulAt={NOW} />,
        );
        expect(screen.getByRole('status')).toHaveTextContent('Connection lost');
        expect(screen.getByRole('status')).toHaveTextContent('Last successful update 2 min ago');
        expect(screen.queryByText('Live')).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Choose instrument' })).not.toBeInTheDocument();
        expect(screen.queryByRole('img', { name: 'Barometer' })).not.toBeInTheDocument();
        expect(screen.queryByText('1012.0')).not.toBeInTheDocument();
    });
});

describe('champagne card honesty — idle is told truthfully, two ways', () => {
    it('fresh instruments with no way on: live readings, no invented "under way"', () => {
        // SOG 0.1 at the berth used to render "Last under way 7 min ago" for
        // a boat that had never been under way (Shane, 2026-09-01) — the
        // timestamp was really the last REPORT.
        const t = { ...telemetry(), sog: 0.1 };
        render(<TelemetryPanel instruments={t} nowMs={NOW} connectionLost={false} lastSuccessfulAt={NOW} />);
        expect(screen.getByText(/No way on/)).toBeInTheDocument();
        expect(screen.getByText('Live')).toBeInTheDocument();
        showBarometer();
        fireEvent.click(screen.getByText('More instruments'));
        expect(screen.getByText('Battery voltage')).toBeVisible();
        expect(screen.getByText('12.8')).toBeInTheDocument();
        expect(screen.queryByText(/under way/i)).toBeNull();
    });

    it('stale instruments: quiet copy with an honest last-heard-from time', () => {
        const t = telemetry(new Date(NOW - PUBLIC_POSITION_FRESH_MS - 60_000).toISOString());
        render(<TelemetryPanel instruments={t} nowMs={NOW} connectionLost={false} lastSuccessfulAt={NOW} />);
        expect(screen.getByText(/Waiting for the next report/)).toBeInTheDocument();
        expect(screen.getByText(/Last report/)).toBeInTheDocument();
        expect(screen.queryByText('1012.0')).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: 'Choose instrument' })).not.toBeInTheDocument();
        expect(screen.queryByText('Live')).not.toBeInTheDocument();
        expect(screen.queryByText(/under way/i)).toBeNull();
    });

    it('withdraws a selected dial when the report expires without another payload', () => {
        const t = telemetry();
        const { rerender } = render(
            <TelemetryPanel instruments={t} nowMs={NOW} connectionLost={false} lastSuccessfulAt={NOW} />,
        );
        showBarometer();
        rerender(
            <TelemetryPanel
                instruments={t}
                nowMs={NOW + PUBLIC_POSITION_FRESH_MS}
                connectionLost={false}
                lastSuccessfulAt={NOW}
            />,
        );
        expect(screen.getByRole('status')).toHaveTextContent('Waiting for the next report');
        expect(screen.queryByRole('group', { name: 'Choose instrument' })).not.toBeInTheDocument();
        expect(screen.queryByRole('img', { name: 'Barometer' })).not.toBeInTheDocument();
        expect(screen.queryByText('1012.0')).not.toBeInTheDocument();
        expect(screen.queryByText('Live')).not.toBeInTheDocument();
    });
});
