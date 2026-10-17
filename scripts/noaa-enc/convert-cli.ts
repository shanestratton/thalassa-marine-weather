/** Headless NOAA-only entry to the boat's shared GDAL converter. No network,
 * server, user coordinates, credential or chart-vault access. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { convertOneCell } from '../../pi-cache/src/s57Converter.js';

const [input, output, editionText, updateText] = process.argv.slice(2);
const cellId = path.basename(input ?? '', '.000').toUpperCase();
if (
    !input ||
    !output ||
    !/^US[0-9][A-Z0-9]{5}$/.test(cellId) ||
    !/^\d{1,5}$/.test(editionText ?? '') ||
    !/^\d{1,5}$/.test(updateText ?? '')
)
    throw Error('Usage: convert-cli.mjs NOAA-cell.000 output.json expected-edition expected-update');
if (
    path.extname(input).toLowerCase() !== '.000' ||
    Number(editionText) < 1 ||
    Number(editionText) > 9999 ||
    Number(updateText) > 9999
)
    throw Error('Invalid official chart revision');
const destination = path.resolve(output);
await fs.mkdir(path.dirname(destination), { recursive: true });
const work = await fs.mkdtemp(path.join(path.dirname(destination), '.noaa-convert-'));
try {
    const conversion = await convertOneCell(path.resolve(input), work, { strictMetadata: true });
    const result = conversion.result as Record<string, unknown>;
    if (
        conversion.cellId !== cellId ||
        result.sourceHO !== 'US' ||
        result.edition !== Number(editionText) ||
        result.updateNumber !== Number(updateText)
    )
        throw Error('Source dataset revision differs from reviewed NOAA catalogue');
    const bytes = Buffer.from(JSON.stringify(conversion.result));
    if (bytes.length > 16 * 1024 * 1024 || conversion.featureCount > 250000)
        throw Error('Converted cell exceeds phone limit');
    await fs.writeFile(destination, bytes, { flag: 'wx' });
    const layers = result.layers as Record<string, { features: { geometry?: { type?: string } }[] }>;
    console.log(
        JSON.stringify({
            cellId,
            edition: result.edition,
            updateNumber: result.updateNumber,
            issued: result.issued,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            features: conversion.featureCount,
            sbdare: layers.SBDARE?.features.length ?? 0,
            sbdarePoints:
                layers.SBDARE?.features.filter((f) => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint')
                    .length ?? 0,
        }),
    );
} finally {
    const resolved = path.resolve(work);
    if (path.dirname(resolved) !== path.dirname(destination) || !path.basename(resolved).startsWith('.noaa-convert-'))
        throw Error('Unsafe conversion cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
}
