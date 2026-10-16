/** Explicit public-NOAA package conversion. The monolith CLI/cap is unchanged.
 * Server artifact only; no provider fetch or publisher access. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { convertOneCell } from '../../pi-cache/src/s57Converter.js';
import { partitionNoaaRecords } from './partition-records';
import type { EncConversionResult } from '../../services/enc/types';
const [input, output, edition, update, zipSha256] = process.argv.slice(2);
const cellId = path.basename(input ?? '', '.000').toUpperCase();
if (
    !input ||
    !output ||
    !/^US[1-6][A-Z0-9]{5}$/.test(cellId) ||
    !/^\d{1,4}$/.test(edition ?? '') ||
    !/^\d{1,4}$/.test(update ?? '') ||
    !/^[a-f0-9]{64}$/.test(zipSha256 ?? '')
)
    throw Error('Pass official cell.000, new output directory, edition, update, retained ZIP SHA256.');
await fs.mkdir(output, { recursive: false });
const temporaryRoot = path.resolve(tmpdir());
const work = await fs.mkdtemp(path.join(temporaryRoot, 'noaa-package-'));
if (path.dirname(path.resolve(work)) !== temporaryRoot || !path.basename(work).startsWith('noaa-package-'))
    throw Error('Unsafe owned temporary directory.');
try {
    const converted = await convertOneCell(path.resolve(input), work, { strictMetadata: true });
    const source = converted.result as unknown as EncConversionResult;
    if (
        converted.cellId !== cellId ||
        source.sourceHO !== 'US' ||
        source.edition !== Number(edition) ||
        source.updateNumber !== Number(update) ||
        converted.featureCount > 250000
    )
        throw Error('Official source identity/count differs from reviewed catalogue.');
    const result = partitionNoaaRecords(source, zipSha256);
    if (result.manifest.bytes + Buffer.byteLength(JSON.stringify(result.manifest)) > 128 * 1024 * 1024)
        throw Error('NOAA package output exceeds its total bound.');
    for (let i = 0; i < result.parts.length; i++)
        await fs.writeFile(path.join(output, `${result.manifest.parts[i].sha256}.json`), result.parts[i], {
            flag: 'wx',
        });
    await fs.writeFile(path.join(output, 'package.json'), JSON.stringify(result.manifest), { flag: 'wx' });
    console.log(
        JSON.stringify({
            cellId,
            parts: result.parts.length,
            features: result.manifest.features,
            bytes: result.manifest.bytes,
            sourceSha256: result.manifest.sourceSha256,
        }),
    );
} finally {
    await fs.rm(work, { recursive: true, force: true });
}
