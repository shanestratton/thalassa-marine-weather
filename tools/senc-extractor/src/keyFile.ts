import { readFile } from 'node:fs/promises';

/** Map of chart basename (without `.oesu` extension) → RInstallKey hex string. */
export type ChartKeyMap = Map<string, string>;

export interface ChartKeyEntry {
    installKey: string;
    /** Native ENC name explicitly attributed by the licensed key XML's <ID>. */
    sourceCellId?: string;
}
export type ChartKeyEntries = Map<string, ChartKeyEntry>;

/** Parse keys and provenance together so a synthetic filename never implies its producer. */
export function parseKeyFile(xml: string): ChartKeyEntries {
    const entries: ChartKeyEntries = new Map();
    const seenFiles = new Set<string>();
    const nativeIds = new Set<string>();
    const chartBlocks = [...xml.matchAll(/<Chart(?:\s[^>]*)?>([\s\S]*?)<\/Chart>/g)];
    if ([...xml.matchAll(/<Chart(?:\s[^>]*)?>/g)].length !== chartBlocks.length)
        throw new Error('Malformed chart key XML');
    for (const match of chartBlocks) {
        const value = (tag: string, required: boolean): string | undefined => {
            const values = [...match[1].matchAll(new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, 'g'))];
            if (values.length > 1 || (required && values.length !== 1))
                throw new Error(`Ambiguous or missing ${tag} in chart key XML`);
            return values[0]?.[1].trim();
        };
        const fileName = value('FileName', true)!;
        const installKey = value('RInstallKey', true)!;
        const sourceCellId = value('ID', false)?.toUpperCase();
        if (!/^[A-Za-z0-9_-]+$/.test(fileName)) throw new Error('Invalid FileName in chart key XML');
        if (!/^[A-Fa-f0-9]+$/.test(installKey)) throw new Error(`Invalid install key for ${fileName}`);
        if (sourceCellId !== undefined && !/^[A-Z0-9]{2}[1-6][A-Z0-9]{5}$/.test(sourceCellId))
            throw new Error(`Invalid native ENC ID for ${fileName}`);
        const normalizedFileName = fileName.toUpperCase();
        if (seenFiles.has(normalizedFileName)) throw new Error(`Duplicate chart key mapping for ${fileName}`);
        if (sourceCellId && nativeIds.has(sourceCellId))
            throw new Error(`Native ENC ID ${sourceCellId} maps to multiple chart files`);
        if (
            /^[A-Z0-9]{2}[1-6][A-Z0-9]{5}$/.test(normalizedFileName) &&
            sourceCellId &&
            normalizedFileName !== sourceCellId
        ) {
            throw new Error(`Native ENC ID conflicts with chart filename ${fileName}`);
        }
        seenFiles.add(normalizedFileName);
        if (sourceCellId) nativeIds.add(sourceCellId);
        entries.set(fileName, { installKey, ...(sourceCellId ? { sourceCellId } : {}) });
    }
    return entries;
}

export async function loadKeyFileEntries(path: string): Promise<ChartKeyEntries> {
    return parseKeyFile(await readFile(path, 'utf8'));
}

/**
 * Parse an o-charts keyFile XML (`oeuSENC-XX-sgl<serial>.XML`) into a
 * { FileName → RInstallKey } map. The keyFile is written by o-charts when
 * the chart set is generated for a specific dongle, so its presence in the
 * chart directory means the dongle is registered and the keys are usable.
 *
 * Format (simplified):
 *   <keyList>
 *     <Chart>
 *       <FileName>OC-61-041834</FileName>
 *       <ID>AU438140</ID>
 *       <RInstallKey>B0B72F2DDE25ACFC...</RInstallKey>
 *     </Chart>
 *     ...
 *   </keyList>
 */
export async function loadKeyFile(path: string): Promise<ChartKeyMap> {
    return new Map([...(await loadKeyFileEntries(path))].map(([fileName, entry]) => [fileName, entry.installKey]));
}
