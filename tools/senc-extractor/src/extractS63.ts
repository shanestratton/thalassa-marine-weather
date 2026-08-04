#!/usr/bin/env node
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { decryptEsenc, S63Permits } from './s63Decrypt.js';
import { parseS63Senc } from './s63SencParser.js';
import { emitCell } from './geojsonEmitter.js';
import { loadPiCacheIndex, savePiCacheIndex, upsertIndexEntry, cellStoreRecord } from './piCacheStore.js';

/**
 * Extract GeoJSON from S-63 charts installed by OpenCPN's s63 plugin.
 *
 * The o-charts path (`decryptBatch.ts`) reads `.oesu` through the oexserverd
 * daemon. S-63 has no daemon: the plugin leaves an XOR-obscured SENC in its
 * cache and the pad is re-derived per file from the permits. See
 * `s63Decrypt.ts`.
 *
 * Permits come from three places, all written by the plugin at import time:
 *   UserPermit / InstallPermit — `opencpn.conf`, section [PlugIns/s63_pi]
 *   cell permit                — `<s63charts>/<n>/<CELL>.os63`, `cellpermit:` line
 *
 * Usage:
 *   tsx src/extractS63.ts --senc-dir ~/.opencpn/s63/s63SENC \
 *                         --chart-dir ~/.opencpn/s63/s63charts \
 *                         --conf ~/.opencpn/opencpn.conf \
 *                         --out ./cells
 */

interface Args {
    sencDir: string;
    chartDir: string;
    confPath: string;
    outDir: string;
    sourceHO: string;
    allClasses: boolean;
    /** When set, also write pi-cache's chart-store format — see piCacheStore.ts. */
    piCacheStore?: string;
}

function parseArgs(argv: string[]): Args | null {
    const home = process.env.HOME ?? '';
    const args: Args = {
        sencDir: join(home, '.opencpn/s63/s63SENC'),
        chartDir: join(home, '.opencpn/s63/s63charts'),
        confPath: join(home, '.opencpn/opencpn.conf'),
        outDir: '',
        sourceHO: '',
        allClasses: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const next = () => argv[++i];
        switch (argv[i]) {
            case '--senc-dir':
                args.sencDir = next();
                break;
            case '--chart-dir':
                args.chartDir = next();
                break;
            case '--conf':
                args.confPath = next();
                break;
            case '--out':
                args.outDir = next();
                break;
            case '--source-ho':
                args.sourceHO = next();
                break;
            case '--all-classes':
                args.allClasses = true;
                break;
            case '--pi-cache-store':
                args.piCacheStore = next();
                break;
            case '--help':
                return null;
        }
    }
    if (args.piCacheStore && !args.outDir) args.outDir = join(args.piCacheStore, 'cells');
    return args.outDir ? args : null;
}

/** Pull the UserPermit and InstallPermit the plugin stored in opencpn.conf. */
async function readPluginPermits(confPath: string): Promise<{ userPermit: string; installPermit: string }> {
    const conf = await readFile(confPath, 'utf8');
    const find = (key: string): string => {
        const m = new RegExp(`^${key}=(.*)$`, 'mi').exec(conf);
        return m ? m[1].trim() : '';
    };
    const userPermit = find('UserPermit');
    const installPermit = find('InstallPermit');
    if (!userPermit || !installPermit) {
        throw new Error(`UserPermit/InstallPermit not found in ${confPath} — has a chart been imported yet?`);
    }
    return { userPermit, installPermit };
}

/**
 * Map cell name → cell permit by reading every `.os63` descriptor under the
 * chart directory. The plugin nests these one level deep, by data server id.
 */
async function readCellPermits(chartDir: string): Promise<Map<string, string>> {
    const permits = new Map<string, string>();
    const entries = await readdir(chartDir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.os63')) continue;
        const text = await readFile(join(entry.parentPath ?? chartDir, entry.name), 'utf8');
        const m = /^cellpermit:(.*)$/m.exec(text);
        if (m) permits.set(basename(entry.name, '.os63').toUpperCase(), m[1].trim());
    }
    return permits;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!args) {
        console.error('usage: extractS63 --out <dir> [--senc-dir <dir>] [--chart-dir <dir>] [--conf <file>]');
        console.error('                  [--source-ho <code>] [--all-classes] [--pi-cache-store <dir>]');
        process.exit(1);
        return;
    }

    const { userPermit, installPermit } = await readPluginPermits(args.confPath);
    const cellPermits = await readCellPermits(args.chartDir);
    const esencFiles = (await readdir(args.sencDir)).filter((f) => f.toLowerCase().endsWith('.es57')).sort();

    console.log(`Found ${esencFiles.length} eSENC file(s) in ${args.sencDir}`);
    await mkdir(args.outDir, { recursive: true });
    const piCacheIndex = args.piCacheStore ? await loadPiCacheIndex(args.piCacheStore) : null;

    let written = 0;
    const failedCells: string[] = [];
    for (const file of esencFiles) {
        const cellId = basename(file, '.es57').toUpperCase();
        const cellPermit = cellPermits.get(cellId);
        if (!cellPermit) {
            console.warn(`  ${cellId}: no cell permit found under ${args.chartDir} — skipped`);
            failedCells.push(cellId);
            continue;
        }

        // One bad cell (revoked permit, corrupt file) must not abort the rest
        // of a multi-cell run — decrypt and parse inside the loop's own guard.
        let senc: Buffer;
        try {
            const permits: S63Permits = { userPermit, installPermit, cellPermit };
            senc = await decryptEsenc(join(args.sencDir, file), permits);
        } catch (err) {
            console.error(`  ${cellId}: ${err instanceof Error ? err.message : String(err)}`);
            failedCells.push(cellId);
            continue;
        }
        const { header, features, skippedGeometry, stats } = parseS63Senc(senc);

        // Cell names are HO-prefixed (FR466870 → SHOM); fall back to that
        // prefix when the caller hasn't named a source explicitly.
        const cell = emitCell(header, features, {
            cellId,
            sourceHO: args.sourceHO || cellId.slice(0, 2),
            classes: args.allClasses ? 'all' : undefined,
        });

        if (piCacheIndex) {
            const { json, meta } = cellStoreRecord(cell);
            await writeFile(join(args.outDir, `${cellId}.json`), json);
            upsertIndexEntry(piCacheIndex, meta);
        } else {
            await writeFile(join(args.outDir, `${cellId}.json`), JSON.stringify(cell));
        }
        written += 1;

        const skippedTotal = Object.values(skippedGeometry).reduce((a, b) => a + b, 0);
        console.log(
            `  ${cellId}: ${features.length} features, ${cell.stats?.emittedFeatures ?? 0} emitted` +
                (skippedTotal ? `, ${skippedTotal} without geometry (${Object.keys(skippedGeometry).join(', ')})` : ''),
        );
        // Every line is rebuilt from the shared vector tables and checked
        // against the extent the chart recorded for it. Failures are withheld
        // from the output, so these counts are the only trace they existed.
        console.log(
            `      ${stats.edgeCount} edges / ${stats.nodeCount} nodes;` +
                ` lines verified against recorded extents: ${stats.linesBboxVerified}` +
                ` (${stats.linesMultiPart} multi-part)` +
                `, withheld: ${stats.linesBboxMismatch} mismatched + ${stats.linesStructuralBreak} damaged`,
        );
        if (stats.linesBboxMismatch > 0 || stats.linesStructuralBreak > 0) {
            console.warn(
                `      WARNING: ${stats.linesBboxMismatch + stats.linesStructuralBreak} line feature(s)` +
                    ` failed verification and were withheld — investigate before trusting this cell`,
            );
        }
        const unknowns = Object.entries(stats.unknownClasses);
        if (unknowns.length > 0) {
            console.warn(
                `      note: ${unknowns.reduce((a, [, n]) => a + n, 0)} feature(s) of unknown class ` +
                    unknowns.map(([k, n]) => `${k}×${n}`).join(', '),
            );
        }
    }

    console.log(`Wrote ${written} cell(s) to ${args.outDir}`);
    if (piCacheIndex && args.piCacheStore) {
        await savePiCacheIndex(args.piCacheStore, piCacheIndex);
        console.log(
            `Wrote pi-cache index → ${join(args.piCacheStore, 'index.json')} (${piCacheIndex.cells.length} cells)`,
        );
    }
    if (failedCells.length > 0) {
        console.error(`${failedCells.length} cell(s) failed and were not written: ${failedCells.join(', ')}`);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
