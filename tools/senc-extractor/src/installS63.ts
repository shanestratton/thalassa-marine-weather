#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Install S-63 cells from a ChartWorld exchange set — the whole job, headless.
 *
 * The OpenCPN S63 plugin's "Import Cell Permits" / "Import Charts" dialogs
 * produce exactly two artefacts per cell: a `.os63` text descriptor and an
 * encrypted SENC built by `OCPNsenc -c`. Both can be made from a shell, so a
 * Pi with no screen can take delivery of a chart. This does that for every
 * cell in an exchange set, then leaves the rest to the pi-cache watcher, which
 * sees the new `.es57` and publishes the GeoJSON on its own.
 *
 *   buy → download → THIS → watcher extracts → /api/enc/installed → app
 *
 * Usage:
 *   tsx src/installS63.ts --exchange ~/Charts/DC40966ACES_ORDER_26_31_01.S63.ZIP \
 *                         --permit   ~/Charts/Serene_Summer_DC40966_latest.prm.zip
 *
 * Both arguments accept a .zip or an already-unpacked directory. Permits come
 * from `opencpn.conf` (Userpermit/Installpermit) and the PERMIT.TXT in the
 * permit bundle, so nothing sensitive is passed on the command line.
 */

interface Args {
    exchange: string;
    permit: string;
    confPath: string;
    sencDir: string;
    chartDir: string;
    s57Data: string;
    pluginPath: string;
    sencUtil: string;
    /** Data-server id — the numeric directory the plugin files cells under. */
    dataServer: string;
    dryRun: boolean;
}

function parseArgs(argv: string[]): Args | null {
    const home = process.env.HOME ?? '';
    const args: Args = {
        exchange: '',
        permit: '',
        confPath: join(home, '.opencpn/opencpn.conf'),
        sencDir: join(home, '.opencpn/s63/s63SENC'),
        chartDir: join(home, '.opencpn/s63/s63charts'),
        s57Data: '/usr/share/opencpn/s57data',
        pluginPath: join(home, '.local/lib/opencpn/libs63_pi.so'),
        sencUtil: join(home, '.local/bin/OCPNsenc'),
        dataServer: '49',
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const next = (): string => argv[++i];
        switch (argv[i]) {
            case '--exchange':
                args.exchange = next();
                break;
            case '--permit':
                args.permit = next();
                break;
            case '--conf':
                args.confPath = next();
                break;
            case '--senc-dir':
                args.sencDir = next();
                break;
            case '--chart-dir':
                args.chartDir = next();
                break;
            case '--s57data':
                args.s57Data = next();
                break;
            case '--plugin':
                args.pluginPath = next();
                break;
            case '--ocpnsenc':
                args.sencUtil = next();
                break;
            case '--data-server':
                args.dataServer = next();
                break;
            case '--dry-run':
                args.dryRun = true;
                break;
            case '--help':
                return null;
        }
    }
    return args.exchange && args.permit ? args : null;
}

/** Unpack a .zip beside itself; pass a directory through untouched. */
async function materialise(path: string, label: string): Promise<string> {
    const abs = resolve(path);
    if (!existsSync(abs)) throw new Error(`${label} not found: ${abs}`);
    if ((await stat(abs)).isDirectory()) return abs;

    const dest = abs.replace(/\.(zip|ZIP)$/, '') + '.unpacked';
    await mkdir(dest, { recursive: true });
    await execFileAsync('unzip', ['-o', '-q', abs, '-d', dest]);
    return dest;
}

/** Recursively find every file whose name matches. */
async function findFiles(root: string, match: (name: string) => boolean): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(root, { withFileTypes: true, recursive: true });
    for (const e of entries) {
        if (e.isFile() && match(e.name)) out.push(join(e.parentPath ?? root, e.name));
    }
    return out;
}

/** UserPermit + InstallPermit as the plugin stored them. */
async function readPluginPermits(confPath: string): Promise<{ userPermit: string; installPermit: string }> {
    const conf = await readFile(confPath, 'utf8');
    const find = (key: string): string => new RegExp(`^${key}=(.*)$`, 'mi').exec(conf)?.[1].trim() ?? '';
    const userPermit = find('UserPermit');
    const installPermit = find('InstallPermit');
    if (!userPermit || !installPermit) {
        throw new Error(`UserPermit/InstallPermit not found in ${confPath}`);
    }
    return { userPermit, installPermit };
}

/** cellId → permit line, from the exchange set's PERMIT.TXT. */
async function readCellPermits(permitDir: string): Promise<Map<string, string>> {
    const files = await findFiles(permitDir, (n) => n.toUpperCase() === 'PERMIT.TXT');
    if (files.length === 0) throw new Error(`no PERMIT.TXT under ${permitDir}`);
    const permits = new Map<string, string>();
    for (const file of files) {
        for (const line of (await readFile(file, 'utf8')).split('\n')) {
            const trimmed = line.trim();
            // Permit lines start with the 8-char cell name; skip :DATE/:ENC etc.
            if (!trimmed || trimmed.startsWith(':')) continue;
            permits.set(trimmed.slice(0, 8).toUpperCase(), trimmed);
        }
    }
    return permits;
}

interface CellFiles {
    cellId: string;
    /** Base cell (.000) — absolute. */
    base: string;
    /** Sequential updates (.001…), ascending. */
    updates: string[];
    /** Edition number, taken from the ENC_ROOT directory layout. */
    edition: number;
}

/**
 * Walk ENC_ROOT and group each cell's base + updates.
 *
 * Layout: `ENC_ROOT/<CC>/<CELL>/<edition>/<update>/<CELL>.<nnn>`. The `L`
 * variants (`FRL66870.000`) are the licence/signature siblings, not chart
 * data, so they are excluded by requiring the filename to match the cell id.
 */
async function collectCells(exchangeDir: string): Promise<CellFiles[]> {
    const roots = await findFiles(exchangeDir, (n) => /^[A-Z0-9]{8}\.\d{3}$/i.test(n));
    const byCell = new Map<string, { files: { path: string; seq: number }[]; edition: number }>();

    for (const path of roots) {
        const name = basename(path);
        const cellId = name.slice(0, 8).toUpperCase();
        // ENC_ROOT/<CC>/<CELL>/… — the cell's own directory must match its id,
        // which drops the FRL66870-style licence files.
        const pathParts = path.split(/[\\/]+/);
        const cellDirectoryIndex = pathParts.findIndex(
            (part, index) => part.toUpperCase() === cellId && /^\d{1,3}$/.test(pathParts[index + 1] ?? ''),
        );
        if (cellDirectoryIndex < 0) continue;
        const seq = Number(extname(name).slice(1));
        const edition = Number(pathParts[cellDirectoryIndex + 1]);
        const entry = byCell.get(cellId) ?? { files: [], edition };
        entry.files.push({ path, seq });
        entry.edition = Math.max(entry.edition, edition);
        byCell.set(cellId, entry);
    }

    const cells: CellFiles[] = [];
    for (const [cellId, { files, edition }] of byCell) {
        files.sort((a, b) => a.seq - b.seq);
        const base = files.find((f) => f.seq === 0);
        if (!base) {
            console.warn(`  ${cellId}: no base .000 in the exchange set — skipped`);
            continue;
        }
        cells.push({ cellId, base: base.path, updates: files.filter((f) => f.seq > 0).map((f) => f.path), edition });
    }
    return cells.sort((a, b) => a.cellId.localeCompare(b.cellId));
}

/** Write the .os63 descriptor the plugin would have written. */
async function writeOs63(cell: CellFiles, permit: string, chartDir: string, dataServer: string): Promise<string> {
    const dir = join(chartDir, dataServer);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${cell.cellId}.os63`);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    const lines = [`cellpermit:${permit}`];
    lines.push(`cellbase:${cell.base};VERSION=1.0,EDTN=${cell.edition},UPDN=0,UADT=${today},ISDT=${today};`);
    cell.updates.forEach((path, i) => {
        lines.push(`cellupdate:${path};VERSION=1.0,EDTN=${cell.edition},UPDN=${i + 1},ISDT=${today};`);
    });
    await writeFile(path, lines.join('\n') + '\n');
    return path;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (!args) {
        console.error('usage: installS63 --exchange <zip|dir> --permit <zip|dir>');
        console.error('       [--conf f] [--senc-dir d] [--chart-dir d] [--s57data d]');
        console.error('       [--plugin so] [--ocpnsenc bin] [--data-server n] [--dry-run]');
        process.exit(1);
        return;
    }

    for (const [label, path] of [
        ['OCPNsenc', args.sencUtil],
        ['s63 plugin', args.pluginPath],
        ['s57data', args.s57Data],
    ] as const) {
        if (!existsSync(path)) throw new Error(`${label} not found at ${path}`);
    }

    const exchangeDir = await materialise(args.exchange, 'exchange set');
    const permitDir = await materialise(args.permit, 'permit bundle');

    const { userPermit, installPermit } = await readPluginPermits(args.confPath);
    const cellPermits = await readCellPermits(permitDir);
    const cells = await collectCells(exchangeDir);

    console.log(`Exchange set holds ${cells.length} cell(s); permit bundle covers ${cellPermits.size}`);
    await mkdir(args.sencDir, { recursive: true });

    let installed = 0;
    for (const cell of cells) {
        const permit = cellPermits.get(cell.cellId);
        if (!permit) {
            console.warn(`  ${cell.cellId}: no permit line in PERMIT.TXT — skipped`);
            continue;
        }
        const updates = cell.updates.length ? ` + ${cell.updates.length} update(s)` : '';
        if (args.dryRun) {
            console.log(`  ${cell.cellId}: would install (ed ${cell.edition}${updates})`);
            continue;
        }

        const os63 = await writeOs63(cell, permit, args.chartDir, args.dataServer);
        const esenc = join(args.sencDir, `${cell.cellId}.es57`);
        const { stdout } = await execFileAsync(args.sencUtil, [
            '-c', // create secure SENC
            '-i',
            cell.base,
            '-o',
            esenc,
            '-p',
            permit,
            '-u',
            userPermit,
            '-e',
            installPermit,
            '-r',
            args.s57Data,
            '-g',
            os63,
            '-z',
            args.pluginPath,
        ]);
        // OCPNsenc exits 0 even when it refuses, so look for its success line.
        if (!/eSENC built OK/i.test(stdout)) {
            console.warn(`  ${cell.cellId}: OCPNsenc did not report success —\n${stdout.trim()}`);
            continue;
        }
        console.log(`  ${cell.cellId}: installed (ed ${cell.edition}${updates}) → ${esenc}`);
        installed += 1;
    }

    console.log(
        args.dryRun
            ? 'Dry run — nothing written.'
            : `Installed ${installed} cell(s). The pi-cache watcher will extract and publish them within ~30s.`,
    );
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
