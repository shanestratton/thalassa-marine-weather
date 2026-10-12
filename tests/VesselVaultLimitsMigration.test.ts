import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The vessel_vault bucket gets the cap every other user bucket has (126-B3a,
// binder audit DOC-2): 25 MiB and the Documents form's own file types. Written
// with 126 and held until 126 was on Shane's phone and iPad (so the drain had
// already kept any over-cap inline file on the phone); released into
// supabase/migrations on his yes, 2026-10-13.
const FILE = '20261013091000_vessel_vault_limits.sql';
const directory = join(process.cwd(), 'supabase/migrations');
const heldDirectory = join(process.cwd(), 'supabase/held-migrations');
const migration = readFileSync(join(directory, FILE), 'utf8');
const sql = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const MIME_TYPES = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/heif',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

describe('vessel_vault limits migration', () => {
    it('sorts after every migration applied live before it, and no other shares its stamp', () => {
        const files = readdirSync(directory).filter((name) => name.endsWith('.sql'));
        // 20261010155000 was the newest applied migration when it was released.
        expect(FILE > '20261010155000_anon_privileges_lockdown.sql').toBe(true);
        expect(files.filter((name) => name.startsWith('20261013091000_'))).toEqual([FILE]);
        expect(files.filter((name) => name.includes('vessel_vault_limits'))).toEqual([FILE]);
    });

    it('is no longer held: the held copy is gone, so it cannot be released twice', () => {
        let held: string[] = [];
        try {
            held = readdirSync(heldDirectory);
        } catch {
            held = [];
        }
        expect(held.filter((name) => name.includes('vessel_vault_limits'))).toEqual([]);
    });

    it('is one UPDATE of the vessel_vault bucket: 25 MiB and exactly the seven types the form takes', () => {
        expect(sql.match(/\bUPDATE\b/gi)).toHaveLength(1);
        expect(sql).toMatch(/UPDATE storage\.buckets\s+SET file_size_limit = 26214400,/);
        expect(sql).toMatch(/WHERE id = 'vessel_vault'/);
        const array = sql.match(/allowed_mime_types = ARRAY\[([\s\S]+?)\]/)?.[1] ?? '';
        const types = [...array.matchAll(/'([^']+)'/g)].map((match) => match[1]);
        expect(types).toEqual(MIME_TYPES);
        // An UPDATE of the live bucket, never a re-insert of it.
        expect(sql).not.toMatch(/INSERT INTO storage\.buckets/i);
    });

    it('raises when no bucket was updated (the DO guard)', () => {
        expect(sql).toMatch(/DO \$\$/);
        expect(sql).toMatch(/GET DIAGNOSTICS \w+ = ROW_COUNT/i);
        expect(sql).toMatch(/RAISE EXCEPTION/i);
    });

    it('touches no policy, grant or table', () => {
        expect(sql).not.toMatch(/\bPOLICY\b/i);
        expect(sql).not.toMatch(/\bGRANT\b|\bREVOKE\b/i);
        expect(sql).not.toMatch(/\bDROP\b/i);
        expect(sql).not.toMatch(/\bALTER\b|\bCREATE\b/i);
    });

    it("says in its header it was released on Shane's yes, and why it waited", () => {
        const header = migration
            .split('\n')
            .filter((line) => line.trim().startsWith('--'))
            .join('\n');
        expect(header).toMatch(/RELEASED 2026-10-13 on Shane's yes/);
        expect(header).toMatch(/126 and 127 are now on his phone and iPad/);
        expect(header).toMatch(/26214400|25 MiB/);
        expect(header).toMatch(/equipment/i);
    });
});
