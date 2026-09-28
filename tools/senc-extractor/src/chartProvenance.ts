import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CHART_SOURCE_FILE = 'thalassa-chart-source.json';
export interface ChartSourceMetadata {
    version: 1;
    sourceHO?: string;
    cells?: Record<string, { sourceHO: string }>;
}

export async function loadChartSourceMetadata(chartDir: string): Promise<ChartSourceMetadata | undefined> {
    let raw: string;
    try {
        raw = await readFile(join(chartDir, CHART_SOURCE_FILE), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    const metadata = JSON.parse(raw) as ChartSourceMetadata;
    if (metadata.version !== 1) throw new Error(`Unsupported ${CHART_SOURCE_FILE} version`);
    return metadata;
}

/** Standard ENC ids identify the producer; synthetic o-charts OC-* ids do not. */
export function resolveChartProducer(
    cellId: string,
    explicit?: string,
    metadata?: ChartSourceMetadata,
    sourceCellId?: string,
): string {
    const standardProducer = /^[A-Z0-9]{2}[1-6][A-Z0-9]{5}$/.test(cellId) ? cellId.slice(0, 2) : undefined;
    if (sourceCellId !== undefined && !/^[A-Z0-9]{2}[1-6][A-Z0-9]{5}$/.test(sourceCellId))
        throw new Error(`Invalid native ENC ID for ${cellId}`);
    if (standardProducer && sourceCellId && cellId !== sourceCellId)
        throw new Error(`Native ENC ID conflicts with chart filename ${cellId}`);
    const stated = [explicit, metadata?.cells?.[cellId]?.sourceHO, metadata?.sourceHO]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim().toUpperCase());
    if (standardProducer) stated.push(standardProducer);
    if (sourceCellId) stated.push(sourceCellId.slice(0, 2));
    if (stated.some((value) => !/^[A-Z0-9]{2}$/.test(value) || value === 'OC'))
        throw new Error(`Invalid producer for ${cellId}`);
    if (new Set(stated).size > 1) throw new Error(`Conflicting producer metadata for ${cellId}`);
    if (stated.length === 0)
        throw new Error(`Unknown producer for ${cellId}; provide verified package metadata or --source-ho`);
    return stated[0];
}
