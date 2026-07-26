import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

vi.mock('../services/weatherService', () => ({
    reverseGeocode: vi.fn(),
}));

import { reverseGeocode } from '../services/weatherService';
import { formatEndpointCoordinates, useEndpointNames } from '../pages/log/useEndpointNames';

const mockedReverseGeocode = vi.mocked(reverseGeocode);

beforeEach(() => {
    mockedReverseGeocode.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('formatEndpointCoordinates', () => {
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
