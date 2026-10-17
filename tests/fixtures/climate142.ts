import { climateExpectedHours, CLIMATE_FULL_YEARS, type ClimateCell } from '../../services/climatology/era5Climate';
/** Fictional counts, with complete mathematical coverage; no public/provider climate. */
export function climateCellFixture(key = '-27,153'): ClimateCell {
    return {
        key,
        months: Array.from({ length: 12 }, (_, month) => {
            const count = climateExpectedHours(month),
                windRose = Array(128).fill(0),
                waveRose = Array(128).fill(0);
            windRose[2] = count;
            waveRose[1] = count;
            return {
                windCount: count,
                waveCount: count,
                windCalm: 0,
                waveCalm: 0,
                galeCount: 0,
                highWaveCount: 0,
                windYears: CLIMATE_FULL_YEARS,
                waveYears: CLIMATE_FULL_YEARS,
                windRose,
                waveRose,
            };
        }),
    };
}
