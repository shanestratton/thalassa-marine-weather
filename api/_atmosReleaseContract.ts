import {
    ATMOS_DATASETS,
    atmosFileBytes,
    canonicalAtmosGeneration,
    validateAtmosManifest,
    type AtmosDataset,
} from '../services/weather/api/atmosContract';
import type { SpecializedReleaseContract } from '../services/weather/api/specializedReleaseContract';

function contract(dataset: AtmosDataset): SpecializedReleaseContract {
    const source = ATMOS_DATASETS[dataset];
    return Object.freeze({
        spec: Object.freeze({
            id: source.id,
            releaseTag: source.releaseTag,
            steps: source.steps,
            cadenceHours: 6,
            maxAssetBytes: atmosFileBytes(dataset),
        }),
        validate(value: unknown, nowMs: number, requireCurrent: boolean): void {
            validateAtmosManifest(value, dataset, nowMs, requireCurrent);
        },
        generation: (dataStart: string, hashes: readonly string[]): string =>
            canonicalAtmosGeneration(dataStart, dataset, hashes),
    });
}

export const ATMOS_RELEASE_CONTRACTS = Object.freeze({
    'gfs-atmos': contract('gfs-atmos'),
    'ifs-pressure': contract('ifs-pressure'),
});
