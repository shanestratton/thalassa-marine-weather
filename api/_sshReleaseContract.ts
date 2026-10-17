import {
    parseSshManifest,
    sshGeneration,
    SSH_DATASET,
    SSH_FILE_BYTES,
} from '../services/weather/api/sshManifestContract';
import type { SpecializedReleaseContract } from '../services/weather/api/specializedReleaseContract';

export const SSH_RELEASE_CONTRACTS = {
    ssh: {
        spec: {
            id: SSH_DATASET,
            releaseTag: 'cmems-ssh-latest',
            steps: 1,
            cadenceHours: 24,
            maxAssetBytes: SSH_FILE_BYTES,
        },
        validate(value: unknown, nowMs: number, requireCurrent: boolean): void {
            parseSshManifest(value, nowMs, requireCurrent);
        },
        generation: sshGeneration,
    },
} as const satisfies Readonly<Record<'ssh', SpecializedReleaseContract>>;
