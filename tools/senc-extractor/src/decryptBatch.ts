#!/usr/bin/env node
import { readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { OexserverdClient } from './oexserverd.js';
import { loadKeyFile } from './keyFile.js';
import { parseSenc } from './featureParser.js';
import { emitCell } from './geojsonEmitter.js';

interface Args {
    chartDir: string;
    outDir: string;
    keyFile?: string;
    binaryPath?: string;
    onlyBbox?: { sLat: number; nLat: number; wLon: number; eLon: number };
    limit?: number;
    skipExisting: boolean;
    sourceHO: string;
    fileExt: string;
}

function parseArgs(argv: string[]): Args | null {
    let chartDir = '';
    let outDir = '';
    let keyFile: string | undefined;
    let binaryPath: string | undefined;
    let onlyBboxStr: string | undefined;
    let limit: number | undefined;
    let skipExisting = false;
    let sourceHO = 'AU';
    let fileExt = '.geojson';

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--charts' && i + 1 < argv.length) chartDir = argv[++i];
        else if (a === '--out' && i + 1 < argv.length) outDir = argv[++i];
        else if (a === '--key-file' && i + 1 < argv.length) keyFile = argv[++i];
        else if (a === '--oexserverd' && i + 1 < argv.length) binaryPath = argv[++i];
        else if (a === '--only-bbox' && i + 1 < argv.length) onlyBboxStr = argv[++i];
        else if (a === '--limit' && i + 1 < argv.length) limit = Number(argv[++i]);
        else if (a === '--skip-existing') skipExisting = true;
        else if (a === '--source-ho' && i + 1 < argv.length) sourceHO = argv[++i];
        else if (a === '--file-ext' && i + 1 < argv.length) fileExt = argv[++i];
    }
    if (!chartDir || !outDir) return null;

    let onlyBbox: Args['onlyBbox'];
    if (onlyBboxStr) {
        const parts = onlyBboxStr.split(',').map(Number);
        if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
            throw new Error('--only-bbox must be wLon,sLat,eLon,nLat');
        }
        onlyBbox = { wLon: parts[0], sLat: parts[1], eLon: parts[2], nLat: parts[3] };
    }

    return { chartDir, outDir, keyFile, binaryPath, onlyBbox, limit, skipExisting, sourceHO, fileExt };
}

function findKeyFile(dir: string, files: string[]): string | undefined {
    const candidate = files.find((f) => /^oeuSENC-.*-sgl[0-9A-Fa-f]+\.XML$/i.test(f));
    return candidate ? join(dir, candidate) : undefined;
}

function bboxIntersects(
    a: { sLat: number; nLat: number; wLon: number; eLon: number },
    b: { sLat: number; nLat: number; wLon: number; eLon: number },
): boolean {
    return !(a.eLon < b.wLon || a.wLon > b.eLon || a.nLat < b.sLat || a.sLat > b.nLat);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args) {
        console.error(
            'usage: decrypt-batch --charts <dir> --out <dir> [--key-file <path>] [--limit N] [--only-bbox wLon,sLat,eLon,nLat] [--skip-existing] [--oexserverd <path>]',
        );
        process.exit(1);
    }

    const files = await readdir(args.chartDir);
    const oesuFiles = files.filter((f) => extname(f).toLowerCase() === '.oesu').sort();

    const keyFilePath = args.keyFile ?? findKeyFile(args.chartDir, files);
    if (!keyFilePath) {
        throw new Error(`no keyFile XML found in ${args.chartDir} (expected oeuSENC-*-sgl<serial>.XML)`);
    }
    const keys = await loadKeyFile(keyFilePath);
    console.log(`Loaded ${keys.size} chart keys from ${basename(keyFilePath)}`);
    console.log(`Found ${oesuFiles.length} .oesu files in ${args.chartDir}`);

    await mkdir(args.outDir, { recursive: true });

    const client = new OexserverdClient({ binaryPath: args.binaryPath, readTimeoutMs: 60000 });
    await client.start();
    console.log('oexserverd ready');

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let bboxFiltered = 0;
    const summary: Array<{ file: string; cellId: string; layers: string[]; featureCount: number; bytes: number }> = [];

    try {
        for (const file of oesuFiles) {
            if (args.limit && processed >= args.limit) break;

            const baseName = basename(file, extname(file));
            const installKey = keys.get(baseName);
            const outPath = join(args.outDir, `${baseName}${args.fileExt}`);
            const t0 = Date.now();

            if (args.skipExisting) {
                try {
                    await stat(outPath);
                    skipped += 1;
                    continue;
                } catch {
                    // doesn't exist, proceed
                }
            }

            if (!installKey) {
                console.warn(`  ${file}: NO KEY in keyFile — skipping`);
                failed += 1;
                continue;
            }

            try {
                const chartPath = join(args.chartDir, file);
                const decrypted = await client.decryptChart(chartPath, installKey);
                const { header, features } = parseSenc(decrypted);

                // Bbox filter — drop charts that don't overlap the requested region.
                if (args.onlyBbox && header.cellExtent) {
                    if (!bboxIntersects(args.onlyBbox, header.cellExtent)) {
                        bboxFiltered += 1;
                        const tParse = Date.now() - t0;
                        console.log(`  ${file}: out-of-bbox (${tParse}ms), skipping write`);
                        continue;
                    }
                }

                const cell = emitCell(header, features, { cellId: baseName, sourceHO: args.sourceHO });
                const json = JSON.stringify(cell);
                await writeFile(outPath, json);

                const tParse = Date.now() - t0;
                const layers = Object.keys(cell.layers);
                summary.push({
                    file,
                    cellId: baseName,
                    layers,
                    featureCount: cell.stats?.emittedFeatures ?? 0,
                    bytes: json.length,
                });
                processed += 1;
                console.log(
                    `  ${file}: ${features.length} feats / ${cell.stats?.emittedFeatures ?? 0} routing  layers=[${layers.join(',')}]  bbox=${header.cellExtent ? `${header.cellExtent.wLon.toFixed(3)},${header.cellExtent.sLat.toFixed(3)}→${header.cellExtent.eLon.toFixed(3)},${header.cellExtent.nLat.toFixed(3)}` : '?'}  ${json.length.toLocaleString()}B  ${tParse}ms`,
                );
            } catch (err) {
                failed += 1;
                console.warn(`  ${file}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    } finally {
        await client.stop();
    }

    console.log();
    console.log(`Done. processed=${processed} skipped=${skipped} bboxFiltered=${bboxFiltered} failed=${failed}`);
    if (summary.length > 0) {
        const totalBytes = summary.reduce((acc, s) => acc + s.bytes, 0);
        const totalFeats = summary.reduce((acc, s) => acc + s.featureCount, 0);
        console.log(
            `Total: ${totalFeats.toLocaleString()} routing features across ${summary.length} cells, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
