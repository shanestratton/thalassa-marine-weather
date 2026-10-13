/**
 * The background re-conversion of installer-retained o-charts sources,
 * retired by Pi update 3 (127-C-d decision 11).
 *
 * It re-ran the extractor over enc-charts/sources/* whenever the extractor's
 * output schema moved, and published the decrypted cells as files. Since Pi
 * update 3 the chart vault opens those same retained, encrypted sets in its
 * own memory, and re-opens everything once, in RAM, when the parser schema
 * changes (vault/vaultIndex.ts). So this pass converts nothing, whatever
 * ENC_SOURCE_RECONVERT_ENABLED says (calypso has it false).
 *
 * The exports stay, so server.ts's start and shutdown and /api/enc/health
 * keep their shape: the status reports 'disabled' with code 'vault-in-memory'.
 */

export interface SourceReconvertStatus {
    state: 'disabled' | 'not-started' | 'waiting' | 'running' | 'stopped' | 'done';
    targetSchema: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    current: null;
    outcomes: never[];
    /** Why nothing runs: 'vault-in-memory' since Pi update 3. */
    code?: string;
}

let status: SourceReconvertStatus = {
    state: 'not-started',
    targetSchema: null,
    startedAt: null,
    finishedAt: null,
    current: null,
    outcomes: [],
};
let told = false;

export function getSourceReconvertStatus(): SourceReconvertStatus {
    return structuredClone(status);
}

/** Converts nothing: the vault re-opens retained sets in RAM. */
export function startSourceReconvert(options: { logger?: Pick<Console, 'log' | 'warn'> } = {}): Promise<void> {
    status = { ...status, state: 'disabled', code: 'vault-in-memory', finishedAt: new Date().toISOString() };
    if (!told) {
        told = true;
        (options.logger ?? console).log(
            '[encReconvert] retained o-charts sets open in the chart vault’s memory (Pi update 3); nothing is re-converted to disk',
        );
    }
    return Promise.resolve();
}

/** Nothing to stop. Kept for server.ts's shutdown, which waits on it. */
export async function stopSourceReconvert(_timeoutMs: number): Promise<'idle' | 'stopped' | 'timed-out'> {
    return 'idle';
}
