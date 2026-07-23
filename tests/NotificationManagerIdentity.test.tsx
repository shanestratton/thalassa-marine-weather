import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const h = vi.hoisted(() => ({
    userId: 'notification-a' as string | null,
    locationName: 'Account A harbour',
    rpc: vi.fn(),
}));

vi.mock('../context/ThalassaContext', () => ({
    useThalassa: () => ({
        user: h.userId ? { id: h.userId } : null,
        weatherData: {
            locationName: h.locationName,
            current: {
                windSpeed: 35,
                windGust: 35,
                waveHeight: 1,
                swellPeriod: 5,
                visibility: 10,
                uvIndex: 1,
                airTemperature: 20,
                condition: 'Clear',
            },
        },
        settings: {
            notifications: {
                wind: { enabled: true, threshold: 30 },
                gusts: { enabled: false, threshold: 50 },
                waves: { enabled: false, threshold: 5 },
                swellPeriod: { enabled: false, threshold: 20 },
                visibility: { enabled: false, threshold: 1 },
                uv: { enabled: false, threshold: 10 },
                tempHigh: { enabled: false, threshold: 40 },
                tempLow: { enabled: false, threshold: 0 },
                precipitation: { enabled: false },
            },
        },
    }),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        rpc: h.rpc,
    },
}));

import { NotificationManager } from '../components/NotificationManager';

describe('NotificationManager account boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        h.userId = 'notification-a';
        h.locationName = 'Account A harbour';
        h.rpc.mockResolvedValue({ error: null });
        setAuthIdentityScope(null);
        setAuthIdentityScope('notification-a');
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('resets de-duplication per account without carrying A alerts into B', async () => {
        const onNotify = vi.fn();
        render(<NotificationManager onNotify={onNotify} />);

        await waitFor(() => expect(onNotify).toHaveBeenCalledWith('🌬 High Wind Alert: 35kts'));
        expect(onNotify).toHaveBeenCalledTimes(1);

        act(() => {
            h.userId = 'notification-b';
            h.locationName = 'Account B harbour';
            setAuthIdentityScope('notification-b');
        });

        await waitFor(() => expect(onNotify).toHaveBeenCalledTimes(2));
        expect(h.rpc).toHaveBeenCalledTimes(2);
        expect(h.rpc.mock.calls.map(([, args]) => args.p_data.location)).toEqual([
            'Account A harbour',
            'Account B harbour',
        ]);
    });
});
