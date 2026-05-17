import { readFile } from 'node:fs/promises';

/** Map of chart basename (without `.oesu` extension) → RInstallKey hex string. */
export type ChartKeyMap = Map<string, string>;

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
 *       <RInstallKey>B0B72F2DDE25ACFC...</RInstallKey>
 *     </Chart>
 *     ...
 *   </keyList>
 */
export async function loadKeyFile(path: string): Promise<ChartKeyMap> {
    const xml = await readFile(path, 'utf8');
    const map: ChartKeyMap = new Map();

    // Lightweight regex parser — the keyFile is machine-emitted and predictable;
    // a streaming XML parser would be overkill for ~1000 simple entries.
    const chartRe = /<Chart>([\s\S]*?)<\/Chart>/g;
    const fileNameRe = /<FileName>\s*([^<\s]+)\s*<\/FileName>/;
    const installKeyRe = /<RInstallKey>\s*([0-9A-Fa-f]+)\s*<\/RInstallKey>/;

    let match: RegExpExecArray | null;
    while ((match = chartRe.exec(xml)) !== null) {
        const block = match[1];
        const fn = fileNameRe.exec(block);
        const ik = installKeyRe.exec(block);
        if (fn && ik) {
            map.set(fn[1], ik[1]);
        }
    }

    return map;
}
