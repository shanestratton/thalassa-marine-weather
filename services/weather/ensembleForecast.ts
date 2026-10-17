import { fetchWeatherFunction } from './openMeteoProxy';
import { parseEnsembleForecast, type EnsembleProduct } from '../../utils/ensembleForecast';

/** Explicit user request only; no routing, winner selection, background polling or persisted location. */
export async function loadEnsembleForecast(
    product: EnsembleProduct,
    latitude: number,
    longitude: number,
    signal: AbortSignal,
) {
    const value = await fetchWeatherFunction<unknown>(
        'ensemble-forecast',
        { product, latitude, longitude },
        18000,
        signal,
    );
    if (signal.aborted) throw new Error('Ensemble request cancelled');
    const parsed = parseEnsembleForecast(value, product, latitude, longitude, Date.now());
    if (!parsed) throw new Error('Ensemble member data unavailable');
    return parsed;
}
