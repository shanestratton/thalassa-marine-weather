/**
 * A buoy's period reaches the app only when it is the dominant (peak) one
 * (build 123, W1-07 review fix).
 *
 * The buoy reading lands in `swellPeriod` tagged 'buoy', and the details grid
 * captions a buoy's period 'Peak period'. NDBC's DPD and the Irish ERDDAP's
 * VTPK are peak periods. The JSON-record wave-buoy path filled the same field
 * with `Tp || Tz`, so a record with no Tp sent its mean zero-crossing period
 * (Tz) in under the peak label. Without Tp the buoy gives no period, and the
 * merger falls back to the model's, which is captioned 'Mean period'.
 *
 * Fictional readings.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pi = vi.hoisted(() => ({
    passthroughJson: vi.fn(),
    passthroughText: vi.fn(),
}));
vi.mock('../services/PiCacheService', () => ({ piCache: pi }));

import { findAndFetchNearestBeacon } from '../services/weather/api/beaconService';
import { MAJOR_BUOYS } from '../services/weather/config';

beforeEach(() => {
    pi.passthroughJson.mockReset();
    pi.passthroughText.mockReset();
});

const at = (id: string) => {
    const b = MAJOR_BUOYS.find((x) => x.id === id);
    if (!b) throw new Error(`no buoy ${id} in MAJOR_BUOYS`);
    return b;
};

const waveRecord = (fields: Record<string, string>) => ({
    success: true,
    result: {
        records: [{ Site: 'Fictional', Hs: '1.42', Direction: '110', SST: '22.1', ...fields }],
    },
});

describe('JSON-record wave buoy: Tp is the peak period, Tz is not', () => {
    const buoy = at('Mooloolaba');

    it('carries Tp through as the buoy period', async () => {
        pi.passthroughJson.mockResolvedValue(waveRecord({ Tp: '11.8', Tz: '6.2' }));
        const obs = await findAndFetchNearestBeacon(buoy.lat, buoy.lon, 1);
        expect(obs?.swellPeriod).toBe(11.8);
    });

    it('gives no period when only the mean zero-crossing period (Tz) is there', async () => {
        pi.passthroughJson.mockResolvedValue(waveRecord({ Tp: '', Tz: '6.2' }));
        const obs = await findAndFetchNearestBeacon(buoy.lat, buoy.lon, 1);
        expect(obs).not.toBeNull();
        expect(obs?.waveHeight).toBe(1.42);
        expect(obs?.swellPeriod).toBeUndefined();
    });
});

describe('NDBC buoy: DPD, the dominant period, still comes through', () => {
    it('Monterey Bay 46042', async () => {
        const buoy = at('46042');
        pi.passthroughText.mockResolvedValue(
            [
                '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP',
                '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC',
                '26 10 08 06 00 300  7.0  9.0   2.4    14   8.1 295 1016.0  14.0  15.2',
            ].join('\n'),
        );
        const obs = await findAndFetchNearestBeacon(buoy.lat, buoy.lon, 1);
        expect(obs?.swellPeriod).toBe(14);
    });
});
