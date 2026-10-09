import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { packagedFetch } from './helpers/packagedFetch';

vi.mock('../services/weatherService', () => ({
    reverseGeocode: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
    CapacitorHttp: {
        get: vi.fn().mockResolvedValue({
            status: 200,
            data: {
                lat: '-20.347503',
                lon: '148.949890',
                address: { village: 'Hamilton Island', city_district: 'Whitsundays' },
            },
        }),
    },
}));

import { reverseGeocode } from '../services/weatherService';
import { formatEndpointCoordinates, useEndpointNames } from '../pages/log/useEndpointNames';

const mockedReverseGeocode = vi.mocked(reverseGeocode);

beforeEach(() => {
    mockedReverseGeocode.mockReset();
    // The QLD place-name table ships in public/ since the 126 bundle diet and is
    // fetched from the app's own files; every other request still fails here.
    const packaged = packagedFetch();
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => (String(input).startsWith('/') ? packaged(input) : { ok: false })),
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('formatEndpointCoordinates', () => {
    it('shows actual island endpoints in the Log rather than the weather district', async () => {
        mockedReverseGeocode.mockResolvedValue('Whitsundays, QLD, AU');
        const { result } = renderHook(() =>
            useEndpointNames(
                { latitude: -20.2543216666667, longitude: 148.815016666667 },
                { latitude: -20.3475033333333, longitude: 148.949890666667 },
            ),
        );
        await waitFor(() =>
            expect(result.current).toEqual({ startLabel: 'Daydream Island', endLabel: 'Hamilton Island' }),
        );
        expect(mockedReverseGeocode).not.toHaveBeenCalled();
    });
    it('uses both signed GPS coordinates at two decimal places when no place name is available', () => {
        expect(formatEndpointCoordinates({ latitude: -27.0142, longitude: 153.9216 })).toBe('-27.01, 153.92');
    });

    it('keeps valid equator and prime-meridian fixes rather than treating zero as missing', () => {
        expect(formatEndpointCoordinates({ latitude: 0, longitude: 18.6421 })).toBe('0.00, 18.64');
        expect(formatEndpointCoordinates({ latitude: -12.3421, longitude: 0 })).toBe('-12.34, 0.00');
    });

    it('does not fabricate a location for missing, invalid, or placeholder coordinates', () => {
        expect(formatEndpointCoordinates({ latitude: 27.01, longitude: null })).toBeNull();
        expect(formatEndpointCoordinates({ latitude: 0, longitude: 0 })).toBeNull();
        expect(formatEndpointCoordinates({ latitude: 91, longitude: 153.92 })).toBeNull();
        expect(formatEndpointCoordinates(undefined)).toBeNull();
    });

    it('replaces a coordinate fallback with a genuine resolved place name', async () => {
        mockedReverseGeocode.mockResolvedValue('Tangalooma, Queensland, Australia');
        const { result } = renderHook(() => useEndpointNames(undefined, { latitude: -27.0333, longitude: 153.3667 }));

        expect(result.current.endLabel).toBe('-27.03, 153.37');

        await waitFor(() => expect(mockedReverseGeocode).toHaveBeenCalledWith(-27.0333, 153.3667));
        await waitFor(() => expect(result.current.endLabel).toBe('Tangalooma'));
    });
});
