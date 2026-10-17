import { refreshModelLiveness, isModelLive } from './modelLiveness';
import { ECMWF_9KM, regionalModelFor } from './regionalModels';

/** Capability is proved by real finite wind through the model's own source,
 * not by bundled allowlists, publisher rows or an HTTP 200 with null values. Probes
 * share the existing daily verdict/inflight/failure backoff; never per swipe. */
export async function refreshCoastalModelCapabilities(point: { lat: number; lon: number }): Promise<void> {
    const regional = regionalModelFor(point.lat, point.lon);
    await Promise.all([ECMWF_9KM, ...(regional ? [regional.id] : [])].map((id) => refreshModelLiveness(id, point)));
}
export function supportedRegionalModel(lat: number, lon: number) {
    const model = regionalModelFor(lat, lon);
    return model && isModelLive(model.id, { lat, lon }) ? model : undefined;
}

/** Migrate only an existing ECMWF pin; Auto and every other choice stay put. */
export function migratedEcmwfPin(stored: unknown): typeof ECMWF_9KM | undefined {
    return stored === 'ecmwf_ifs025' && isModelLive(ECMWF_9KM) ? ECMWF_9KM : undefined;
}

/** Commit a delayed migration only for the identity and pin that started it. */
export function applyEcmwfPinMigration(
    originalPin: unknown,
    isCurrentIdentity: () => boolean,
    readPin: () => unknown,
    writePin: (model: typeof ECMWF_9KM) => void,
): boolean {
    const migrated = migratedEcmwfPin(originalPin);
    if (!migrated || !isCurrentIdentity() || readPin() !== originalPin) return false;
    writePin(migrated);
    return true;
}
