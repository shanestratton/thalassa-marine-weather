/**
 * Bulk CSV Import — Load downloaded vessel registries into vessel_metadata.
 *
 * Usage:
 *   npx ts-node src/import-csv.ts <file.csv> <format>
 *
 * Supported formats:
 *   itu    — ITU MARS List V export (Ship Name, MMSI, Call Sign, etc.)
 *   amsa   — AMSA Registered Ships CSV
 *   uscg   — USCG PSIX vessel documentation
 *   auto   — Auto-detect columns by header names
 *
 * Example:
 *   npx ts-node src/import-csv.ts ~/Downloads/mars_list_v.csv auto
 *
 * The script reads CSV, maps columns to vessel_metadata fields, and
 * bulk upserts into Supabase in batches of 500.
 */

import * as fs from 'fs';
import { upsertMetadata, VesselMetadataRow } from './supabase';

type Format = 'itu' | 'amsa' | 'uscg' | 'auto';

// ── Column mapping per format ──

interface ColumnMap {
    mmsi: string;
    name: string;
    callSign: string;
    type: string;
    flag: string;
    imo: string;
    loa: string;
    beam: string;
    draft: string;
}

const FORMAT_COLUMNS: Record<Exclude<Format, 'auto'>, ColumnMap> = {
    itu: {
        mmsi: 'MMSI',
        name: 'Ship Name',
        callSign: 'Call Sign',
        type: 'Ship Type',
        flag: 'Flag',
        imo: 'IMO Number',
        loa: '', beam: '', draft: '',
    },
    amsa: {
        mmsi: 'MMSI_NUMBER',
        name: 'VESSEL_NAME',
        callSign: 'CALL_SIGN',
        type: 'VESSEL_TYPE',
        flag: 'FLAG',
        imo: 'IMO_NUMBER',
        loa: 'LENGTH_OVERALL',
        beam: 'BREADTH',
        draft: 'DEPTH_DRAUGHT',
    },
    uscg: {
        mmsi: 'MMSI',
        name: 'Vessel Name',
        callSign: 'Call Sign',
        type: 'Vessel Type',
        flag: 'Flag',
        imo: 'IMO Number',
        loa: 'Length',
        beam: 'Breadth',
        draft: 'Depth',
    },
};

// ── Country → emoji lookup ──
const COUNTRY_FLAGS: Record<string, string> = {
    'australia': '🇦🇺', 'united states': '🇺🇸', 'usa': '🇺🇸',
    'united kingdom': '🇬🇧', 'uk': '🇬🇧', 'great britain': '🇬🇧',
    'panama': '🇵🇦', 'liberia': '🇱🇷', 'marshall islands': '🇲🇭',
    'bahamas': '🇧🇸', 'malta': '🇲🇹', 'singapore': '🇸🇬',
    'hong kong': '🇭🇰', 'china': '🇨🇳', 'japan': '🇯🇵',
    'south korea': '🇰🇷', 'korea': '🇰🇷', 'norway': '🇳🇴',
    'denmark': '🇩🇰', 'sweden': '🇸🇪', 'finland': '🇫🇮',
    'germany': '🇩🇪', 'france': '🇫🇷', 'italy': '🇮🇹',
    'spain': '🇪🇸', 'portugal': '🇵🇹', 'greece': '🇬🇷',
    'netherlands': '🇳🇱', 'belgium': '🇧🇪', 'ireland': '🇮🇪',
    'canada': '🇨🇦', 'mexico': '🇲🇽', 'brazil': '🇧🇷',
    'india': '🇮🇳', 'russia': '🇷🇺', 'turkey': '🇹🇷',
    'indonesia': '🇮🇩', 'philippines': '🇵🇭', 'vietnam': '🇻🇳',
    'thailand': '🇹🇭', 'malaysia': '🇲🇾', 'new zealand': '🇳🇿',
    'cyprus': '🇨🇾', 'bermuda': '🇧🇲', 'cayman islands': '🇰🇾',
    'gibraltar': '🇬🇮', 'isle of man': '🇮🇲', 'antigua': '🇦🇬',
    'antigua and barbuda': '🇦🇬', 'st vincent': '🇻🇨',
    'tuvalu': '🇹🇻', 'vanuatu': '🇻🇺', 'fiji': '🇫🇯',
    'tonga': '🇹🇴', 'samoa': '🇼🇸', 'tanzania': '🇹🇿',
    'south africa': '🇿🇦', 'egypt': '🇪🇬', 'nigeria': '🇳🇬',
    'uae': '🇦🇪', 'united arab emirates': '🇦🇪', 'saudi arabia': '🇸🇦',
    'taiwan': '🇹🇼', 'croatia': '🇭🇷', 'iceland': '🇮🇸',
    'poland': '🇵🇱', 'romania': '🇷🇴', 'ukraine': '🇺🇦',
    'estonia': '🇪🇪', 'latvia': '🇱🇻', 'lithuania': '🇱🇹',
    'bulgaria': '🇧🇬', 'slovenia': '🇸🇮', 'ecuador': '🇪🇨',
    'peru': '🇵🇪', 'chile': '🇨🇱', 'argentina': '🇦🇷',
    'colombia': '🇨🇴', 'cuba': '🇨🇺', 'jamaica': '🇯🇲',
    'belize': '🇧🇿', 'honduras': '🇭🇳', 'costa rica': '🇨🇷',
    'barbados': '🇧🇧', 'trinidad': '🇹🇹', 'trinidad and tobago': '🇹🇹',
    'dominica': '🇩🇲', 'morocco': '🇲🇦', 'tunisia': '🇹🇳',
    'algeria': '🇩🇿', 'kenya': '🇰🇪', 'ghana': '🇬🇭',
    'cameroon': '🇨🇲', 'angola': '🇦🇴', 'mozambique': '🇲🇿',
    'madagascar': '🇲🇬', 'mauritius': '🇲🇺', 'seychelles': '🇸🇨',
    'sri lanka': '🇱🇰', 'pakistan': '🇵🇰', 'bangladesh': '🇧🇩',
    'myanmar': '🇲🇲', 'cambodia': '🇰🇭', 'brunei': '🇧🇳',
    'qatar': '🇶🇦', 'kuwait': '🇰🇼', 'bahrain': '🇧🇭',
    'oman': '🇴🇲', 'jordan': '🇯🇴', 'israel': '🇮🇱',
    'lebanon': '🇱🇧', 'iran': '🇮🇷', 'iraq': '🇮🇶',
};

function flagForCountry(country: string): string | null {
    const lower = country.toLowerCase().trim();
    return COUNTRY_FLAGS[lower] ?? null;
}

// ── Simple CSV parser ──
function parseCSV(text: string): { headers: string[]; rows: string[][] } {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length === 0) return { headers: [], rows: [] };

    const parseLine = (line: string): string[] => {
        const fields: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === ',' && !inQuotes) {
                fields.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        fields.push(current.trim());
        return fields;
    };

    const headers = parseLine(lines[0]);
    const rows = lines.slice(1).map(parseLine);
    return { headers, rows };
}

// ── Auto-detect format from headers ──
function detectFormat(headers: string[]): ColumnMap {
    const lowerHeaders = new Set(headers.map(h => h.toLowerCase()));

    // Try exact format matches
    for (const [format, cols] of Object.entries(FORMAT_COLUMNS)) {
        const mmsiCol = cols.mmsi.toLowerCase();
        if (lowerHeaders.has(mmsiCol)) {
            console.log(`   Auto-detected format: ${format}`);
            return cols;
        }
    }

    // Fuzzy match — find columns containing key terms
    const findCol = (terms: string[]): string => {
        for (const h of headers) {
            const lower = h.toLowerCase();
            if (terms.some(t => lower.includes(t))) return h;
        }
        return '';
    };

    return {
        mmsi: findCol(['mmsi']),
        name: findCol(['ship name', 'vessel name', 'vessel_name', 'shipname', 'name']),
        callSign: findCol(['call sign', 'call_sign', 'callsign']),
        type: findCol(['ship type', 'vessel type', 'vessel_type', 'shiptype', 'type']),
        flag: findCol(['flag', 'country', 'flag_country']),
        imo: findCol(['imo', 'imo_number', 'imonumber']),
        loa: findCol(['length', 'loa', 'length_overall']),
        beam: findCol(['breadth', 'beam', 'width']),
        draft: findCol(['depth', 'draft', 'draught']),
    };
}

// ── Main ──

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.log('Usage: npx ts-node src/import-csv.ts <file.csv> [format]');
        console.log('Formats: itu, amsa, uscg, auto (default)');
        process.exit(1);
    }

    const filePath = args[0];
    const format = (args[1] || 'auto') as Format;

    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`📥 BULK IMPORT — Vessel Registry CSV`);
    console.log(`   File: ${filePath}`);
    console.log(`   Format: ${format}`);
    console.log(`${'═'.repeat(50)}\n`);

    const text = fs.readFileSync(filePath, 'utf-8');
    const { headers, rows } = parseCSV(text);

    console.log(`   Headers: ${headers.join(', ')}`);
    console.log(`   Rows: ${rows.length}\n`);

    // Get column mapping
    const columns = format === 'auto'
        ? detectFormat(headers)
        : FORMAT_COLUMNS[format];

    if (!columns.mmsi) {
        console.error('❌ Could not find MMSI column. Available headers:', headers.join(', '));
        process.exit(1);
    }

    console.log(`   Column mapping:`);
    console.log(`     MMSI:      "${columns.mmsi}"`);
    console.log(`     Name:      "${columns.name}"`);
    console.log(`     Call Sign: "${columns.callSign}"`);
    console.log(`     Type:      "${columns.type}"`);
    console.log(`     Flag:      "${columns.flag}"`);
    console.log(`     IMO:       "${columns.imo}"`);
    console.log(`     LOA:       "${columns.loa}"`);
    console.log(`     Beam:      "${columns.beam}"`);
    console.log(`     Draft:     "${columns.draft}"\n`);

    // Build header index
    const idx: Record<string, number> = {};
    for (let i = 0; i < headers.length; i++) {
        idx[headers[i]] = i;
    }

    const getVal = (row: string[], col: string): string | null => {
        if (!col || idx[col] === undefined) return null;
        const v = row[idx[col]];
        return v && v.trim() ? v.trim() : null;
    };

    const getNum = (row: string[], col: string): number | null => {
        const v = getVal(row, col);
        if (!v) return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
    };

    // Parse rows
    const results: VesselMetadataRow[] = [];
    let skipped = 0;

    for (const row of rows) {
        const mmsiStr = getVal(row, columns.mmsi);
        if (!mmsiStr) { skipped++; continue; }

        const mmsi = parseInt(mmsiStr.replace(/\D/g, ''), 10);
        if (isNaN(mmsi) || mmsi < 100000000 || mmsi > 999999999) { skipped++; continue; }

        const name = getVal(row, columns.name);
        const flag = getVal(row, columns.flag);
        const flagEmoji = flag ? flagForCountry(flag) : null;

        // Detect data source from format
        const dataSource = format === 'amsa' ? 'AMSA'
            : format === 'uscg' ? 'USCG'
            : format === 'itu' ? 'ITU_MARS'
            : 'Registry';

        results.push({
            mmsi,
            vessel_name: name,
            vessel_type: getVal(row, columns.type),
            flag_country: flag,
            flag_emoji: flagEmoji,
            call_sign: getVal(row, columns.callSign),
            imo_number: getNum(row, columns.imo),
            loa: getNum(row, columns.loa),
            beam: getNum(row, columns.beam),
            draft: getNum(row, columns.draft),
            data_source: dataSource,
            is_verified: true,
        });
    }

    console.log(`   Parsed: ${results.length} vessels (${skipped} skipped)\n`);

    if (results.length === 0) {
        console.log('❌ No valid vessels found in CSV');
        process.exit(1);
    }

    // Upsert in batches
    console.log(`   Upserting ${results.length} vessels...`);
    const upserted = await upsertMetadata(results);
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`✅ IMPORT COMPLETE: ${upserted} vessels loaded`);
    console.log(`${'═'.repeat(50)}\n`);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error('💥 Fatal error:', e);
        process.exit(1);
    });
