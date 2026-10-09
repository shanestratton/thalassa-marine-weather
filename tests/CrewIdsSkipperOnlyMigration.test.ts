import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Crew IDs stay with the skipper (126-B4, binder audit DOC-3).
 *
 * Sharing Documents with crew shares the boat's papers. Before this file the
 * only read policy on ship_documents had no category term, so every crew
 * member with Documents shared read every other crew member's passport row,
 * and through "Crew read shared vault files" opened the scan.
 *
 * These checks pin the migration text: the read policy keeps 'Crew Visas/IDs'
 * for the owner; UPDATE gains the same term in USING only (an UPDATE with no
 * WHERE skips the read policy: the live replay re-filed a hidden passport
 * that way), its WITH CHECK unchanged; INSERT and DELETE are exactly as
 * 20260723100000 wrote them; the vault read policy only gains the
 * record-file tie in its documents branch; and the push fails unless the
 * live policy set is exact.
 */

const MIGRATIONS_DIR = 'supabase/migrations';
const CREW_IDS = '20261010140000_crew_ids_skipper_only.sql';
const HARDENING = '20260723100000_crew_manifest_hardening.sql';
const VAULT_CREW_READ = '20261002120000_vessel_vault_crew_read.sql';
/** The newest migration applied on live when this file was written (2026-10-10). */
const LIVE_NEWEST = '20261009172000';
/** The newest migration on b126 (a70fb628) when this file was written: 126-03b. */
const NEWEST_ON_B126 = '20261010130000_anchor_watch_keeper_heartbeat.sql';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
const sqlOf = (relative: string): string => read(relative).replace(/--.*$/gm, '');
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();

const migrationFiles = fs
    .readdirSync(path.join(process.cwd(), MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();

const exists = fs.existsSync(path.join(process.cwd(), MIGRATIONS_DIR, CREW_IDS));
const header = exists ? read(`${MIGRATIONS_DIR}/${CREW_IDS}`) : '';
const crewIds = exists ? squash(sqlOf(`${MIGRATIONS_DIR}/${CREW_IDS}`)) : '';

const TABLES = {
    ship_documents: String.raw`(?:public\.)?"?ship_documents"?`,
    objects: String.raw`storage\.objects`,
};

/** Policy name → its CREATE POLICY statement, for one table, after the given migrations in order. */
function finalPolicies(table: keyof typeof TABLES, files: string[] = migrationFiles): Map<string, string> {
    const policies = new Map<string, string>();
    const statement = new RegExp(
        String.raw`(create|drop)\s+policy\s+(?:if\s+exists\s+)?"?([a-z0-9_ ]+?)"?\s+on\s+${TABLES[table]}\b[^;]*;`,
        'gi',
    );
    for (const file of files) {
        if (!fs.existsSync(path.join(process.cwd(), MIGRATIONS_DIR, file))) continue;
        const sql = sqlOf(`${MIGRATIONS_DIR}/${file}`);
        for (const match of sql.matchAll(statement)) {
            const [whole, verb, name] = match;
            if (verb.toLowerCase() === 'drop') policies.delete(name);
            else policies.set(name, squash(whole));
        }
    }
    return policies;
}

/** The record-file tie this file adds to the vault policy's documents branch. */
const RECORD_FILE_TIE = "and split_part(split_part(objects.name, '/', 3), '.', 1) = d.id::text";

describe('crew IDs stay with the skipper (20261010140000)', () => {
    it('exists, and sorts after every migration live today and every 126 file before it', () => {
        expect(migrationFiles).toContain(CREW_IDS);
        // Relative checks only: later 126 migrations land after this one, and
        // finalPolicies() already reads the whole tree, so a later file that
        // rewrote these policies would fail the checks below.
        expect(CREW_IDS > LIVE_NEWEST).toBe(true);
        expect(CREW_IDS > NEWEST_ON_B126).toBe(true);
        expect(migrationFiles.filter((name) => name.startsWith('20261010140000_'))).toEqual([CREW_IDS]);
    });

    it('says in its header that it is not pushed, why, and what old builds see', () => {
        expect(header).toContain('Not pushed with this commit');
        expect(header).toContain("Shane's yes");
        expect(header).toContain('Crew Visas/IDs');
        expect(header).toMatch(/42501/);
        expect(header).toMatch(/Undo/);
        // The one residual the record-file tie leaves, named with its later fix.
        expect(header).toContain('The one residual: an orphan scan.');
    });

    it("lets crew read every paper but the crew's IDs, and the owner all of theirs", () => {
        const policies = finalPolicies('ship_documents');
        const reads = [...policies.entries()].filter(([, sql]) => /\bfor select\b/.test(sql));
        expect(reads.map(([name]) => name)).toEqual(['Register members read documents']);
        const select = reads[0][1];
        expect(select).toContain('for select to authenticated');
        expect(select).toContain('user_id = auth.uid()');
        expect(select).toContain("category <> 'crew visas/ids'");
        expect(select).toContain("public.can_access_vessel_register(user_id, 'documents', false)");
        // The category term binds the crew branch only: the owner keeps their IDs.
        expect(select).toMatch(
            /user_id = auth\.uid\(\) or \( category <> 'crew visas\/ids' and public\.can_access_vessel_register\(user_id, 'documents', false\) \)/,
        );
        expect(select).not.toMatch(/using \(\s*true\s*\)/);
        // No FOR ALL policy anywhere on the table.
        expect([...policies.values()].some((sql) => /\bfor all\b/.test(sql))).toBe(false);
    });

    it('keeps hidden IDs out of reach of an update, and leaves INSERT and DELETE exactly as 20260723100000 wrote them', () => {
        const final = finalPolicies('ship_documents');
        const hardening = finalPolicies(
            'ship_documents',
            migrationFiles.filter((file) => file <= HARDENING),
        );
        expect([...final.keys()].sort()).toEqual([
            'Document owners delete',
            'Register editors create documents',
            'Register editors update documents',
            'Register members read documents',
        ]);
        for (const name of ['Register editors create documents', 'Document owners delete']) {
            expect(final.get(name)).toBe(hardening.get(name));
        }
        const update = final.get('Register editors update documents') as string;
        expect(update).toContain('for update to authenticated');
        expect(update).toMatch(
            /using \( user_id = auth\.uid\(\) or \( category <> 'crew visas\/ids' and public\.can_access_vessel_register\(user_id, 'documents', true\) \) \)/,
        );
        // WITH CHECK exactly as before: no edit the app makes today is newly refused.
        const withCheck = (sql: string) => sql.slice(sql.indexOf(' with check '));
        expect(withCheck(update)).toBe(withCheck(hardening.get('Register editors update documents') as string));
        expect(withCheck(update)).toBe(" with check (public.can_access_vessel_register(user_id, 'documents', true));");
        // This file writes the read and update policies on the table, and the vault read.
        expect([...crewIds.matchAll(/create policy "([^"]+)" on ([a-z_.]+)/g)].map((m) => m.slice(1))).toEqual([
            ['register members read documents', 'public.ship_documents'],
            ['register editors update documents', 'public.ship_documents'],
            ['crew read shared vault files', 'storage.objects'],
        ]);
    });

    it("ties a crew member's vault read to the file's own record, and changes nothing else in storage", () => {
        const final = finalPolicies('objects').get('Crew read shared vault files') as string;
        const before = finalPolicies('objects', [VAULT_CREW_READ]).get('Crew read shared vault files') as string;
        expect(before).toBeTruthy();
        // Exactly one added term, inside the documents branch.
        expect(final.split(RECORD_FILE_TIE)).toHaveLength(2);
        expect(final.replace(` ${RECORD_FILE_TIE}`, '')).toBe(before);
        const documentsBranch = final.slice(final.indexOf("= 'documents' and exists"), final.indexOf("= 'equipment'"));
        expect(documentsBranch).toContain(RECORD_FILE_TIE);
        expect(final).toContain('for select to authenticated');
        // No upload, replace or delete policy, and no other storage policy.
        expect(crewIds).not.toMatch(/on storage\.objects for (insert|update|delete|all)\b/);
        expect(crewIds).not.toMatch(/for (insert|delete|all)\b/);
        expect([
            ...crewIds.matchAll(/(?:create|drop) policy (?:if exists )?"([^"]+)" on storage\.objects/g),
        ]).toHaveLength(2);
    });

    it('fails the push unless the policy sets are exact, and can be re-run', () => {
        expect(crewIds).toContain('do $check$');
        expect(crewIds).toContain(
            `'{"document owners delete": "delete", "register editors create documents": "insert", "register editors update documents": "update", "register members read documents": "select"}'::jsonb`,
        );
        expect(crewIds).toContain(`'["crew read shared vault files", "users can view own vault files"]'::jsonb`);
        expect(crewIds).toContain("raise exception 'crew ids skipper only: ship_documents has policies %'");
        expect(crewIds).toContain("raise exception 'crew ids skipper only: open policies on ship_documents: %'");
        expect(crewIds).toContain(
            "raise exception 'crew ids skipper only: crew ids term missing from the read policy'",
        );
        expect(crewIds).toContain(
            "raise exception 'crew ids skipper only: crew ids term missing from the update policy'",
        );
        expect(crewIds).toContain(
            "raise exception 'crew ids skipper only: record-file tie missing from crew read shared vault files'",
        );
        expect(crewIds).toContain("raise exception 'crew ids skipper only: vessel_vault readers are %'");
        // Open = FOR ALL, true, or reachable by anon/public.
        expect(crewIds).toContain("roles && array['public', 'anon']::name[]");
        expect(crewIds).toContain('drop policy if exists "register members read documents" on public.ship_documents;');
        expect(crewIds).toContain(
            'drop policy if exists "register editors update documents" on public.ship_documents;',
        );
        expect(crewIds).toContain('drop policy if exists "crew read shared vault files" on storage.objects;');
        expect(crewIds).not.toMatch(/(^|;)\s*(begin|commit)\s*;/);
        expect(crewIds).not.toContain('set local');
        expect(crewIds).toContain("set lock_timeout = '5s';");
        expect(crewIds).toContain('reset lock_timeout;');
    });

    it('grants nothing and creates no function', () => {
        expect(crewIds).not.toMatch(/\bgrant\b/);
        expect(crewIds).not.toMatch(/\bcreate (or replace )?function\b/);
        expect(crewIds).not.toMatch(/\balter table\b/);
    });
});
