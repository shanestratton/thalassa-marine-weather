/**
 * Polar File Parser — Parses .pol and .csv polar files
 * Supports Expedition (.pol) and OpenCPN (.csv) formats.
 */
import type { PolarData } from '../types';

/**
 * Parse a polar file (either .pol or .csv format).
 * Returns normalized PolarData or throws on invalid input.
 */
export function parsePolarFile(content: string, filename: string): PolarData {
    const ext = filename.toLowerCase().split('.').pop();
    if (ext === 'pol') return parseExpeditionPol(content);
    if (ext === 'csv') return parseCSVPolar(content);
    // Try auto-detect: if tabs → .pol, if commas → .csv
    if (content.includes('\t')) return parseExpeditionPol(content);
    return parseCSVPolar(content);
}

/**
 * Parse Expedition .pol format:
 * First line: TWA\t6\t8\t10\t12\t15\t20\t25
 * Subsequent: 45\t5.2\t6.1\t6.8\t7.2\t7.5\t7.6\t7.4
 */
function parseExpeditionPol(content: string): PolarData {
    const lines = content.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) throw new Error('Polar file must have at least a header and one data row');

    const headerParts = lines[0].split(/\t+/).map(s => s.trim());
    // First column is the label (TWA or similar), rest are wind speeds
    const windSpeeds = headerParts.slice(1).map(Number).filter(n => !isNaN(n) && n > 0);
    if (windSpeeds.length === 0) throw new Error('No valid wind speeds found in header');

    const angles: number[] = [];
    const matrix: number[][] = [];

    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(/\t+/).map(s => s.trim());
        const angle = parseFloat(parts[0]);
        if (isNaN(angle) || angle < 0 || angle > 180) continue;

        angles.push(angle);
        const row = parts.slice(1, windSpeeds.length + 1).map(v => {
            const n = parseFloat(v);
            return isNaN(n) ? 0 : clampSpeed(n);
        });
        // Pad with zeros if row is shorter than wind speeds
        while (row.length < windSpeeds.length) row.push(0);
        matrix.push(row);
    }

    if (angles.length === 0) throw new Error('No valid wind angle rows found');
    return { windSpeeds, angles, matrix };
}

/**
 * Parse CSV polar format (OpenCPN):
 * TWA,6,8,10,12,15,20,25
 * 45,5.2,6.1,6.8,7.2,7.5,7.6,7.4
 */
function parseCSVPolar(content: string): PolarData {
    const lines = content.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) throw new Error('Polar file must have at least a header and one data row');

    // Handle both comma and semicolon delimiters
    const delimiter = lines[0].includes(';') ? ';' : ',';
    const headerParts = lines[0].split(delimiter).map(s => s.trim());
    const windSpeeds = headerParts.slice(1).map(Number).filter(n => !isNaN(n) && n > 0);
    if (windSpeeds.length === 0) throw new Error('No valid wind speeds found in header');

    const angles: number[] = [];
    const matrix: number[][] = [];

    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(delimiter).map(s => s.trim());
        const angle = parseFloat(parts[0]);
        if (isNaN(angle) || angle < 0 || angle > 180) continue;

        angles.push(angle);
        const row = parts.slice(1, windSpeeds.length + 1).map(v => {
            const n = parseFloat(v);
            return isNaN(n) ? 0 : clampSpeed(n);
        });
        while (row.length < windSpeeds.length) row.push(0);
        matrix.push(row);
    }

    if (angles.length === 0) throw new Error('No valid wind angle rows found');
    return { windSpeeds, angles, matrix };
}

/** Clamp boat speed to reasonable range (0-30 kts) */
function clampSpeed(speed: number): number {
    return Math.max(0, Math.min(30, speed));
}

/** Validate polar data for obvious errors */
export function validatePolarData(data: PolarData): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];

    if (data.windSpeeds.length === 0) return { valid: false, warnings: ['No wind speeds defined'] };
    if (data.angles.length === 0) return { valid: false, warnings: ['No wind angles defined'] };
    if (data.matrix.length !== data.angles.length) return { valid: false, warnings: ['Matrix rows don\'t match angle count'] };

    // Check for anomalous values (potential typos)
    for (let a = 0; a < data.angles.length; a++) {
        for (let w = 0; w < data.windSpeeds.length; w++) {
            const speed = data.matrix[a]?.[w] ?? 0;
            if (speed > 20) {
                warnings.push(`Unusually high speed ${speed}kts at ${data.angles[a]}°/${data.windSpeeds[w]}kts TWS`);
            }
        }
    }

    // Check for non-monotonic wind speeds
    for (let i = 1; i < data.windSpeeds.length; i++) {
        if (data.windSpeeds[i] <= data.windSpeeds[i - 1]) {
            warnings.push(`Wind speeds not monotonically increasing: ${data.windSpeeds[i - 1]} ≥ ${data.windSpeeds[i]}`);
        }
    }

    return { valid: true, warnings };
}

/** Create an empty polar data matrix with default wind speeds and angles */
export function createEmptyPolar(): PolarData {
    const windSpeeds = [6, 8, 10, 12, 15, 20, 25];
    const angles = [45, 60, 90, 120, 150, 180];
    const matrix = angles.map(() => windSpeeds.map(() => 0));
    return { windSpeeds, angles, matrix };
}
