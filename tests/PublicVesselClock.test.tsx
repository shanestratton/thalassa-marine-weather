import React from 'react';
import tzLookup from 'tz-lookup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
    publicInstrumentSnapshot,
    publicInstrumentTimeZone,
    publicVesselTimeZone,
} from '../supabase/functions/_shared/public-instruments';
import { PublicInstrumentDials, publicShipClock } from '../src/components/PublicInstrumentDials';
import { readFileSync } from 'node:fs';

const now = Date.parse('2026-09-07T04:00:00Z');
const fix = (lat: number, lon: number, at = now) => ({ lat, lon, updated_at: new Date(at).toISOString() });
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('ship clock follows the vessel position', () => {
    it.each([
        ['Brisbane', -27.47, 153.03, 'Australia/Brisbane', 14],
        ['Lady Musgrave', -23.9, 152.4, 'Australia/Brisbane', 14],
        ['Whitsundays', -20.25, 148.95, 'Australia/Brisbane', 14],
        ['New Caledonia', -22.27, 166.45, 'Pacific/Noumea', 15],
        ['Vanuatu', -17.74, 168.32, 'Pacific/Efate', 15],
    ])('uses the local zone at %s', (_name, lat, lon, expected, hour) => {
        const zone = publicVesselTimeZone(fix(lat as number, lon as number), tzLookup, now);
        expect(zone).toBe(expected);
        expect(publicShipClock(now, zone)?.hour).toBe(hour);
    });
    it('updates when the boat moves and applies local daylight saving, not Brisbane forever', () => {
        const summer = Date.parse('2026-12-01T04:00:00Z');
        const brisbane = publicVesselTimeZone(fix(-27.47, 153.03, summer), tzLookup, summer);
        const sydney = publicVesselTimeZone(fix(-33.86, 151.2, summer), tzLookup, summer);
        expect(publicShipClock(summer, brisbane)?.hour).toBe(14);
        expect(publicShipClock(summer, sydney)?.hour).toBe(15);
    });
    it('does not invent a location from missing, invalid, stale or future coordinates', () => {
        for (const position of [
            null,
            {},
            fix(0, 0),
            fix(91, 0),
            fix(NaN, 153),
            fix(-27, 153, now - 600_000),
            fix(-27, 153, now + 60_001),
        ]) {
            expect(publicVesselTimeZone(position, tzLookup, now)).toBeNull();
        }
        expect(publicVesselTimeZone(fix(-27, 153), () => 'bad-zone', now)).toBeNull();
    });
    it('ignores a conflicting Pi zone and never uses the destination', () => {
        const zone = publicVesselTimeZone(fix(-22.27, 166.45), tzLookup, now);
        const snapshot = publicInstrumentSnapshot(
            {
                boat_id: 'boat',
                reported_at: new Date(now).toISOString(),
                extra: { ship_time_zone: 'Australia/Brisbane' },
            },
            'boat',
            now,
            zone,
        )!;
        expect(snapshot.ship_time_zone).toBe('Pacific/Noumea');
        expect(snapshot).not.toHaveProperty('lat');
        const api = readFileSync('supabase/functions/voyage-log/index.ts', 'utf8');
        expect(api).toContain('publicInstrumentTimeZone(cloud, boatId, telemetry, tzLookup, snapshotNow)');
    });
    it('works at the berth without publishing the boat coordinates', () => {
        const row = {
            boat_id: 'boat',
            reported_at: new Date(now).toISOString(),
            lat: -27.47,
            lon: 153.03,
            extra: { position_at: now - 1_000 },
        };
        const zone = publicInstrumentTimeZone(row, 'boat', null, tzLookup, now);
        expect(zone).toBe('Australia/Brisbane');
        const snapshot = publicInstrumentSnapshot(row, 'boat', now, zone)!;
        expect(snapshot.ship_time_zone).toBe('Australia/Brisbane');
        for (const key of ['lat', 'lon', 'extra', 'position_at']) expect(snapshot).not.toHaveProperty(key);
        expect(publicInstrumentTimeZone(row, 'other-boat', null, tzLookup, now)).toBeNull();
    });
    it('does not freshen a cached boat position with a new report; can use a recent published fix', () => {
        for (const position_at of [undefined, 'bad', NaN, Infinity, now - 600_000, now + 5_001]) {
            const row = {
                boat_id: 'boat',
                reported_at: new Date(now).toISOString(),
                lat: -27.47,
                lon: 153.03,
                extra: { position_at },
            };
            expect(publicInstrumentTimeZone(row, 'boat', null, tzLookup, now)).toBeNull();
            expect(publicInstrumentTimeZone(row, 'boat', fix(-22.27, 166.45), tzLookup, now)).toBe('Pacific/Noumea');
        }
    });
    it('renders the live bell in vessel time and follows a new position zone', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const snapshot = publicInstrumentSnapshot(
            { boat_id: 'boat', reported_at: new Date(now).toISOString() },
            'boat',
            now,
            'Australia/Brisbane',
        )!;
        const { rerender } = render(<PublicInstrumentDials instruments={snapshot} />);
        fireEvent.click(screen.getByRole('button', { name: 'Ship’s bell' }));
        expect(screen.getByText('Vessel local time · Australia/Brisbane')).toBeTruthy();
        rerender(<PublicInstrumentDials instruments={{ ...snapshot, ship_time_zone: 'Pacific/Noumea' }} />);
        expect(screen.getByText('Vessel local time · Pacific/Noumea')).toBeTruthy();
    });
});
