/**
 * The seabed core runs in three places: the phone (services/seabed), the Pi
 * (pi-cache/src/seabed) and the ingest function (supabase/functions/_shared).
 * A sounding must be judged the same way wherever it was taken, so the three
 * copies are identical below one marker line. Edit the app copy, copy the rest.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MARKER = '// ── seabed-core: everything below this line is identical in all three copies ──';
const COPIES = [
    'services/seabed/seabedCore.ts',
    'pi-cache/src/seabed/seabedCore.ts',
    'supabase/functions/_shared/seabedCore.ts',
];

function below(path: string): string {
    const text = readFileSync(path, 'utf8');
    const at = text.indexOf(MARKER);
    expect(at, `${path} has lost its marker line`).toBeGreaterThan(-1);
    expect(text.indexOf(MARKER, at + 1), `${path} has the marker twice`).toBe(-1);
    return text.slice(at);
}

describe('seabed core mirrors', () => {
    it('are byte-for-byte the same below the marker', () => {
        const [master, ...mirrors] = COPIES.map(below);
        expect(master.length).toBeGreaterThan(5_000);
        for (const [i, mirror] of mirrors.entries()) {
            expect(mirror, `${COPIES[i + 1]} differs from ${COPIES[0]}`).toBe(master);
        }
    });

    it('stay free of imports, so each runtime can load its copy on its own', () => {
        for (const path of COPIES) {
            expect(below(path)).not.toMatch(/^\s*import\s/m);
            expect(below(path)).not.toMatch(/\brequire\(/);
        }
    });
});
