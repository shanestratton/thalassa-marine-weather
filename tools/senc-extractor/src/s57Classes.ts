import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface S57Class {
    code: number;
    acronym: string;
    name: string;
    primitives: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

let cache: Map<number, S57Class> | null = null;

export function loadS57Classes(csvPath?: string): Map<number, S57Class> {
    if (cache) return cache;
    const path = csvPath ?? resolve(__dirname, '../reference/s57objectclasses.csv');
    const csv = readFileSync(path, 'utf8');
    const lines = csv.split('\n').slice(1);
    const map = new Map<number, S57Class>();
    for (const line of lines) {
        if (!line.trim()) continue;
        const cols = parseCsvLine(line);
        if (cols.length < 8) continue;
        const code = Number(cols[0]);
        if (!Number.isFinite(code) || code === 0) continue;
        const name = cols[1];
        const acronym = cols[2];
        const primitives = cols[7];
        if (!acronym) continue;
        map.set(code, { code, acronym, name, primitives });
    }
    cache = map;
    return map;
}

function parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (c === ',' && !inQuotes) {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += c;
    }
    out.push(cur);
    return out;
}

export function classAcronym(code: number): string {
    const klass = loadS57Classes().get(code);
    return klass ? klass.acronym : `?${code}`;
}

export function classRecord(code: number): S57Class | undefined {
    return loadS57Classes().get(code);
}

export const ROUTING_CLASSES = new Set([
    'LNDARE',
    'DEPARE',
    'DEPCNT',
    'COALNE',
    'OBSTRN',
    'WRECKS',
    'UWTROC',
    'ROCKS',
    'DRGARE',
    'FAIRWY',
    'BOYLAT',
    'BCNLAT',
    'BOYSPP',
    'BCNSPP',
    'BOYCAR',
    'BCNCAR',
    'LIGHTS',
    // Leading lines / transits (masterplan Phase 6 — offline leads):
    // NAVLNE = navigation line (the charted lead), RECTRC = recommended
    // track. RECTRC is known-empty in the current AU SENC set
    // (PHASE_14_SPIKE) — emitted anyway for future cells.
    'NAVLNE',
    'RECTRC',
]);
