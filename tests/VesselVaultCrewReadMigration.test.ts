import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Shared binders (2026-10-02): crew can open a skipper's shared documents and
// equipment manuals, and nothing else in the vault. Not pushed by the build:
// it widens storage read access, so Shane decides.
const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20261002120000_vessel_vault_crew_read.sql'),
    'utf8',
);
const sql = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

describe('vessel_vault crew read migration', () => {
    it('adds one SELECT-only policy for authenticated users on the vessel_vault bucket', () => {
        const policies = sql.match(/CREATE POLICY/gi) ?? [];
        expect(policies).toHaveLength(1);
        expect(sql).toMatch(
            /CREATE POLICY "Crew read shared vault files"\s+ON storage\.objects FOR SELECT\s+TO authenticated/,
        );
        expect(sql).toContain("bucket_id = 'vessel_vault'");
        expect(sql).not.toMatch(/FOR\s+(INSERT|UPDATE|DELETE|ALL)\b/i);
        expect(sql).not.toMatch(/WITH CHECK/i);
        expect(sql).not.toMatch(/\bTO\s+(anon|public)\b/i);
    });

    it('limits the grant to the documents and equipment subfolders, as the tables decide it', () => {
        expect(sql).toContain("split_part(objects.name, '/', 2) IN ('documents', 'equipment')");
        expect(sql).toMatch(
            /public\.can_access_vessel_register\(\s*split_part\(objects\.name, '\/', 1\)::uuid,\s*split_part\(objects\.name, '\/', 2\),\s*false\s*\)/,
        );
    });

    it('grants a FILE only while a row the reader can see points at it, never a whole folder', () => {
        // Prod 2026-10-02: every object in the test skipper's vault was an
        // orphan no row referenced; a folder-wide grant would have handed all
        // of them to any crew member the moment Documents was shared.
        const documents = sql.match(/= 'documents'\s+AND EXISTS \(([\s\S]+?)\n\s{16}\)/)?.[1] ?? '';
        const equipment = sql.match(/= 'equipment'\s+AND EXISTS \(([\s\S]+?)\n\s{16}\)/)?.[1] ?? '';
        expect(documents).toContain('FROM public.ship_documents d');
        expect(documents).toContain("d.user_id = split_part(objects.name, '/', 1)::uuid");
        expect(documents).toContain("d.file_uri = 'supabase-storage://vessel_vault/' || objects.name");
        expect(equipment).toContain('FROM public.equipment_register e');
        expect(equipment).toContain("e.user_id = split_part(objects.name, '/', 1)::uuid");
        expect(equipment).toContain("e.manual_uri = 'supabase-storage://vessel_vault/' || objects.name");
        // A legacy URL reference must END in the object's path (before any
        // query string), not merely contain it.
        expect(documents).toMatch(/right\(\s*split_part\(d\.file_uri, '\?', 1\),/);
        expect(equipment).toMatch(/right\(\s*split_part\(e\.manual_uri, '\?', 1\),/);
        // The file tie is ANDed with the register check, inside the guarded branch.
        expect(sql).toMatch(/false\s*\)\s*AND \(\s*\(\s*split_part\(objects\.name, '\/', 2\) = 'documents'/);
        // Subqueries never leave the object's name unqualified (a future
        // 'name' column on either table would silently capture it).
        expect(`${documents}${equipment}`).not.toMatch(/(?<![.\w])name\b/);
    });

    it('guards the uuid cast inside CASE, so a non-uuid path is false rather than an error', () => {
        const caseBlock = sql.match(/CASE[\s\S]+END/)?.[0] ?? '';
        expect(caseBlock).toMatch(/WHEN split_part\(objects\.name, '\/', 1\) ~\* '\^\[0-9a-f\]\{8\}-/);
        expect(caseBlock).toContain('::uuid');
        expect(caseBlock).toMatch(/ELSE false\s+END/);
        // The cast appears nowhere outside the guarded branch.
        expect(sql.replace(caseBlock, '')).not.toContain('::uuid');
    });

    it('leaves the owner-only write policies alone', () => {
        expect(sql).not.toMatch(/DROP POLICY IF EXISTS "Users can (upload to|view|update|delete) own vault/i);
        // And keeps the storage verification migration's guard text clear.
        expect(sql).not.toMatch(/chat-avatars/i);
    });
});
