import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface S57Attribute {
    code: number;
    acronym: string;
    name: string;
    /** Source type from S-57 catalog: A=list, L=list, F=float, S=string, I=integer, E=enumerated */
    type: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

let cache: Map<number, S57Attribute> | null = null;

export function loadS57Attributes(csvPath?: string): Map<number, S57Attribute> {
    if (cache) return cache;
    const path = csvPath ?? resolve(__dirname, '../reference/s57attributes.csv');
    const csv = readFileSync(path, 'utf8');
    const lines = csv.split('\n').slice(1);
    const map = new Map<number, S57Attribute>();
    for (const line of lines) {
        if (!line.trim()) continue;
        const cols = parseCsvLine(line);
        if (cols.length < 4) continue;
        const code = Number(cols[0]);
        if (!Number.isFinite(code) || code === 0) continue;
        const acronym = cols[2];
        if (!acronym) continue;
        map.set(code, {
            code,
            acronym,
            name: cols[1],
            type: cols[3],
        });
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

export function attributeAcronym(code: number): string {
    const attr = loadS57Attributes().get(code);
    return attr ? attr.acronym : `_attr${code}`;
}
