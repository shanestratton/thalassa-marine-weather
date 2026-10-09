/**
 * The personal chart shelf closes on the server (126-20).
 *
 * o-charts (Roberto, 2026-10-10, pasted by Shane): "Storing unencrypted data
 * on any medium, and especially in the cloud, is strictly prohibited by the
 * terms of the licenses signed with the chart providers." Every installed
 * build up to 125 uploads decrypted cells to enc-cells/u/<uid>/ and reads them
 * back, so the client switch in services/enc/personalCellSync.ts is not
 * enough on its own: 20261010115000 drops the owner read, insert and update
 * policies, and only the owner delete and the NOAA-only root read remain.
 *
 * Shane pushes this file early from the encshelfpush worktree (commit
 * 1a3af662) and the 126 release push then finds it applied, so the copy here
 * must stay byte for byte the one he pushed: the hash pin below trips on any
 * edit.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/migrations';
const FILE = '20261010115000_enc_cells_personal_shelf_closed.sql';
/** sha256 of the file as committed on encshelfpush (1a3af662). */
const PUSHED_SHA256 = '9639cd29b62f50614e7fa02345f8f0a580eed584f732e097e58770a5daa66e55';

const names = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
const raw = names.includes(FILE) ? readFileSync(`${DIR}/${FILE}`, 'utf8') : '';
const header = raw.slice(0, raw.indexOf('SET lock_timeout'));
const executable = raw.replace(/--[^\n]*/g, '');
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const OWNER_CLOSED = ['enc cells owner read', 'enc cells owner insert', 'enc cells owner update'];
const KEPT = ['enc cells owner delete', 'enc cells shared read noaa'];

/** storage.objects policy name -> its CREATE statement, after every migration in order. */
function finalObjectPolicies(): Map<string, string> {
    const policies = new Map<string, string>();
    const statement =
        /(create|drop)\s+policy\s+(?:if\s+exists\s+)?"?([a-z0-9_ ]+?)"?\s+on\s+storage\.objects\b[^;]*;/gi;
    for (const name of names) {
        const sql = readFileSync(`${DIR}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
        for (const [whole, verb, policy] of sql.matchAll(statement)) {
            if (verb.toLowerCase() === 'drop') policies.delete(policy);
            else policies.set(policy, squash(whole));
        }
    }
    return policies;
}

describe('the personal chart shelf closes (20261010115000)', () => {
    it('exists with a stamp of its own, after crew IDs and before the Pi alarm events', () => {
        expect(names).toContain(FILE);
        expect(names.filter((name) => name.startsWith('20261010115000_'))).toEqual([FILE]);
        expect(FILE > '20261010110000_crew_ids_skipper_only.sql').toBe(true);
        expect(FILE < '20261010120000_pi_alarm_events.sql').toBe(true);
        // Both neighbours are real files, so the ordering is not vacuous.
        expect(names).toContain('20261010110000_crew_ids_skipper_only.sql');
        expect(names).toContain('20261010120000_pi_alarm_events.sql');
    });

    it('is byte for byte the file Shane pushes early', () => {
        expect(
            createHash('sha256')
                .update(readFileSync(`${DIR}/${FILE}`))
                .digest('hex'),
        ).toBe(PUSHED_SHA256);
    });

    it('drops exactly the three owner policies, and creates nothing', () => {
        const drops = [...executable.matchAll(/drop\s+policy\s+if\s+exists\s+"([^"]+)"\s+on\s+storage\.objects\s*;/gi)];
        expect(drops.map((match) => match[1])).toEqual(OWNER_CLOSED);
        expect(executable).not.toMatch(/create\s+policy/i);
        expect(executable).not.toMatch(/alter\s+policy/i);
        for (const kept of KEPT) expect(executable).not.toMatch(new RegExp(`drop\\s+policy[^;]*"${kept}"`, 'i'));
    });

    it('deletes no objects and runs no transaction control of its own', () => {
        expect(executable).not.toMatch(/delete\s+from/i);
        expect(executable).not.toMatch(/\b(begin|commit|rollback)\s*;/i);
        expect(executable).toContain("SET lock_timeout = '5s';");
        expect(executable).toContain('RESET lock_timeout;');
    });

    it('checks itself: the push fails if an owner policy survives or anything else still opens enc-cells', () => {
        const check = squash(executable.slice(executable.indexOf('DO $check$'), executable.indexOf('$check$;')));
        expect(check).toContain(
            "policyname IN ('enc cells owner read', 'enc cells owner insert', 'enc cells owner update')",
        );
        expect(check).toContain("RAISE EXCEPTION 'personal chart shelf still open: % owner policies remain'");
        expect(check).toContain("LIKE '%enc-cells%'");
        expect(check).toContain("policyname NOT IN ('enc cells owner delete', 'enc cells shared read noaa')");
        expect(check).toContain("RAISE EXCEPTION 'unexpected enc-cells policies remain: %'");
    });

    it('leaves the whole tree with only the owner delete and the NOAA-only shared read on enc-cells', () => {
        const encCells = [...finalObjectPolicies().entries()].filter(([, sql]) => sql.includes("'enc-cells'"));
        expect(encCells.map(([name]) => name).sort()).toEqual([...KEPT].sort());
        const [, deletePolicy] = encCells.find(([name]) => name === 'enc cells owner delete')!;
        expect(deletePolicy).toContain('for delete to authenticated');
        expect(deletePolicy).toContain('(storage.foldername(name))[2] = auth.uid()::text');
        const [, noaa] = encCells.find(([name]) => name === 'enc cells shared read noaa')!;
        expect(noaa).toContain("name ~ '^US[0-9][A-Z0-9]{5}\\.json$'");
        expect(noaa).toContain("name not like 'u/%'");
    });

    it('says why, quoting the licence holder, and how to undo it', () => {
        expect(header).toContain('Storing unencrypted data on any medium, and especially in the cloud,');
        expect(header).toContain('is strictly prohibited by the terms of the licenses signed with the');
        expect(header).toContain('Nothing is deleted here.');
        expect(header).toMatch(
            /Undo: re-create the three policies exactly as in\s+-- 20260807093000_personal_enc_cells\.sql/,
        );
    });
});
