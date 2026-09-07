import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PublicInstrumentDials, publicShipClock } from '../src/components/PublicInstrumentDials';
import { TelemetryPanel } from '../src/components/TelemetryPanel';
import { publicInstrumentSnapshot } from '../supabase/functions/_shared/public-instruments';
import { AttitudeGauge } from '../components/nmea/gauges/AttitudeGauge';
import type { VoyageLogInstruments } from '../src/voyageLogApi';

const now = Date.parse('2026-09-07T04:00:00Z');
const instruments = (extra: Partial<VoyageLogInstruments> = {}): VoyageLogInstruments => ({
    ...publicInstrumentSnapshot(
        {
            boat_id: 'boat',
            reported_at: new Date(now).toISOString(),
            sog_kts: 0,
            heading_deg: 43,
            cog_deg: 91,
            awa_deg: -39,
            aws_kts: 8,
            tws_kts: 10,
            twa_deg: 39,
            rudder_deg: -18.3,
        },
        'boat',
        now,
    )!,
    ...extra,
});
afterEach(cleanup);

describe('public native instrument faces', () => {
    it('uses signed bow-relative apparent and true angles, not direction or COG', () => {
        render(<PublicInstrumentDials instruments={instruments({ twd: 240 })} />);
        expect(screen.getByText('39° PORT')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'True wind' }));
        expect(screen.getByText('39° STBD')).toBeTruthy();
    });
    it('uses actual COG, never substitutes heading, and rounds north to 000', () => {
        const { rerender } = render(<PublicInstrumentDials instruments={instruments()} />);
        fireEvent.click(screen.getByRole('button', { name: 'COG' }));
        const compass = screen.getByRole('img', { name: 'Course over ground compass' });
        expect(within(compass).getByText('091')).toBeTruthy();
        rerender(<PublicInstrumentDials instruments={instruments({ cog: null })} />);
        expect(within(compass).getByText('---')).toBeTruthy();
        rerender(<PublicInstrumentDials instruments={instruments({ cog: 359.6 })} />);
        expect(within(compass).getByText('000')).toBeTruthy();
    });
    it('keeps true wind direction separate when the bow angle is missing', () => {
        render(<PublicInstrumentDials instruments={instruments({ twa: null, twd: 240 })} />);
        fireEvent.click(screen.getByRole('button', { name: 'True wind' }));
        expect(screen.getByText('True wind angle not reported.')).toBeTruthy();
    });
    it('shows signed rudder sides and an actual off-scale numeric angle', () => {
        const { rerender } = render(<PublicInstrumentDials instruments={instruments()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Helm' }));
        expect(screen.getByText('18.3°')).toBeTruthy();
        expect(screen.getByText('PORT')).toBeTruthy();
        rerender(<PublicInstrumentDials instruments={instruments({ rudder: 55 })} />);
        expect(screen.getByText('55.0°')).toBeTruthy();
        expect(screen.getByText('STARBOARD')).toBeTruthy();
    });
    it('gives independent attitude faces unique resources and honest level/no-data labels', () => {
        const { container } = render(
            <>
                <AttitudeGauge angle={0} axis="heel" />
                <AttitudeGauge angle={null} axis="pitch" />
            </>,
        );
        expect(screen.getByText('LEVEL')).toBeTruthy();
        expect(screen.getByText('NO DATA')).toBeTruthy();
        const ids = Array.from(container.querySelectorAll('[id]'), (node) => node.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
    it('never falls back to the visitor timezone for an absent or invalid ship setting', () => {
        expect(publicShipClock(now, null)).toBeNull();
        expect(publicShipClock(now, 'not-a-zone')).toBeNull();
        expect(publicShipClock(now, 'Australia/Brisbane')).toMatchObject({ hour: 14, minute: 0 });
    });
    it('replaces voltage with real house SOC and expires it independently', () => {
        const data = instruments({
            house_battery_soc: 94.6,
            house_battery_at: new Date(now).toISOString(),
            voltage: 13.7,
        });
        const { rerender } = render(
            <TelemetryPanel instruments={data} nowMs={now} connectionLost={false} lastSuccessfulAt={now} />,
        );
        expect(screen.getByText('94.6')).toBeTruthy();
        expect(screen.getByText('House battery')).toBeTruthy();
        rerender(
            <TelemetryPanel instruments={data} nowMs={now + 181_000} connectionLost={false} lastSuccessfulAt={now} />,
        );
        expect(screen.queryByText('94.6')).toBeNull();
    });
    it('withdraws the gauges completely on connection loss or a stale report', () => {
        const { rerender } = render(
            <TelemetryPanel instruments={instruments()} nowMs={now} connectionLost lastSuccessfulAt={now} />,
        );
        expect(screen.queryByRole('group', { name: 'Choose instrument' })).toBeNull();
        rerender(
            <TelemetryPanel
                instruments={instruments()}
                nowMs={now + 600_000}
                connectionLost={false}
                lastSuccessfulAt={now}
            />,
        );
        expect(screen.queryByRole('group', { name: 'Choose instrument' })).toBeNull();
    });
});
