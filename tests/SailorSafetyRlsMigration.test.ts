import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// These legacy tables exist in production but had no migration or RLS.
// Source checks protect the repair contract; deployed role checks are separate.
const migration = readFileSync('supabase/migrations/20260909023000_secure_sailor_blocks_and_reports.sql', 'utf8');
const code = migration.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const statements = code
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
const tables = ['sailor_blocks', 'sailor_reports'] as const;
type SafetyTable = (typeof tables)[number];

function permissionStatements(action: 'GRANT' | 'REVOKE', table: SafetyTable, role: string) {
    const separator = action === 'GRANT' ? 'TO' : 'FROM';
    const pattern = new RegExp(
        `^${action}\\s+([\\s\\S]+?)\\s+ON\\s+(?:TABLE\\s+)?([\\s\\S]+?)\\s+${separator}\\s+([\\s\\S]+)$`,
        'i',
    );
    return statements.flatMap((statement, index) => {
        const match = statement.match(pattern);
        if (!match) return [];
        const targets = match[2]
            .toLowerCase()
            .replace(/"/g, '')
            .split(/\s*,\s*/);
        const roles = match[3]
            .toLowerCase()
            .replace(/"/g, '')
            .split(/\s*,\s*/);
        if (!targets.includes(`public.${table}`) || !roles.includes(role.toLowerCase())) return [];
        return [{ index, privileges: match[1].toLowerCase().trim() }];
    });
}

function grants(table: SafetyTable, role: string): string[] {
    return permissionStatements('GRANT', table, role)
        .flatMap(({ privileges }) =>
            [...privileges.matchAll(/([a-z]+)(?:\s+privileges)?\s*(?:\(([^)]*)\))?/g)].map((match) => {
                const columns = match[2]
                    ?.split(',')
                    .map((column) => column.trim())
                    .sort();
                return columns ? `${match[1]}(${columns.join(',')})` : match[1];
            }),
        )
        .sort();
}

function policies(table: SafetyTable) {
    const pattern = new RegExp(
        `^CREATE\\s+POLICY\\s+(?:"[^"]+"|[a-z0-9_]+)\\s+ON\\s+public\\.${table}\\b([\\s\\S]*)$`,
        'i',
    );
    return statements.flatMap((statement) => {
        const match = statement.match(pattern);
        if (!match) return [];
        const operation = match[1].match(/\bFOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i)?.[1].toLowerCase();
        return [{ operation, body: match[1] }];
    });
}

describe('legacy sailor block and report RLS repair', () => {
    it('captures the existing text identity columns without destructive schema changes', () => {
        for (const table of tables) {
            const create = statements.find((statement) =>
                new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+public\\.${table}\\b`, 'i').test(statement),
            );
            expect(create, `${table} must also exist on a fresh database`).toBeDefined();
            expect(create).toMatch(/\bid\s+UUID\b/i);
            expect(create).toMatch(/\bDEFAULT\s+gen_random_uuid\s*\(\s*\)/i);
            expect(create).toMatch(/\bcreated_at\s+TIMESTAMPTZ\b/i);
            expect(create).toMatch(/\bDEFAULT\s+now\s*\(\s*\)/i);
            const identities =
                table === 'sailor_blocks' ? ['blocker_id', 'blocked_id'] : ['reporter_id', 'reported_id'];
            for (const column of identities) {
                expect(create).toMatch(new RegExp(`\\b${column}\\s+TEXT\\s+NOT\\s+NULL\\b`, 'i'));
            }
            if (table === 'sailor_blocks') {
                expect(create).toMatch(/\bUNIQUE\s*\(\s*blocker_id\s*,\s*blocked_id\s*\)/i);
            } else {
                expect(create).toMatch(/\breason\s+TEXT\s+NOT\s+NULL\b/i);
            }
        }
        expect(code).not.toMatch(/\b(?:DROP\s+TABLE|TRUNCATE|DISABLE\s+ROW\s+LEVEL\s+SECURITY)\b/i);
    });

    it('enables RLS and removes inherited public/client grants before granting access', () => {
        for (const table of tables) {
            expect(code).toMatch(
                new RegExp(`ALTER\\s+TABLE\\s+public\\.${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'),
            );
            for (const role of ['public', 'anon', 'authenticated']) {
                const revoked = permissionStatements('REVOKE', table, role).find(({ privileges }) =>
                    /^all(?:\s+privileges)?$/.test(privileges),
                );
                expect(revoked, `${role} defaults must be removed from ${table}`).toBeDefined();
                for (const grant of permissionStatements('GRANT', table, role)) {
                    expect(revoked!.index).toBeLessThan(grant.index);
                }
            }
            expect(grants(table, 'anon')).toEqual([]);
            expect(grants(table, 'public')).toEqual([]);
            expect(grants(table, 'service_role')).toEqual(['all']);
        }
    });

    it('preserves block browsing, repeated upserts, and unblocking without writable metadata', () => {
        expect(grants('sailor_blocks', 'authenticated')).toEqual([
            'delete',
            'insert(blocked_id,blocker_id)',
            'select',
            'update(blocked_id,blocker_id)',
        ]);
        const blockPolicies = policies('sailor_blocks');
        expect(
            blockPolicies
                .flatMap(({ operation }) =>
                    operation === 'all' ? ['select', 'insert', 'update', 'delete'] : [operation],
                )
                .sort(),
        ).toEqual(['delete', 'insert', 'select', 'update']);
        for (const { operation, body } of blockPolicies) {
            expect(body).toMatch(/\bTO\s+authenticated\s+(?:USING|WITH\s+CHECK)\b/i);
            expect(body).not.toMatch(/\bOR\b|\bUSING\s*\(\s*true\s*\)/i);
            const owner = /\bblocker_id\s*=\s*\(\s*SELECT\s+auth\.uid\(\s*\)\s*\)\s*::\s*text\b/i;
            if (operation !== 'insert') {
                const using = body.split(/\bWITH\s+CHECK\b/i)[0];
                expect(using).toMatch(/\bUSING\s*\(/i);
                expect(using).toMatch(owner);
            }
            if (operation === 'insert' || operation === 'update' || operation === 'all') {
                const check = body.split(/\bWITH\s+CHECK\b/i)[1];
                expect(check).toBeDefined();
                expect(check).toMatch(owner);
            }
        }
    });

    it('allows attributed report submissions while keeping report contents and maintenance private', () => {
        expect(grants('sailor_reports', 'authenticated')).toEqual([
            'insert(created_at,reason,reported_id,reporter_id)',
        ]);
        const reportPolicies = policies('sailor_reports');
        expect(reportPolicies).toHaveLength(1);
        expect(reportPolicies[0].operation).toBe('insert');
        expect(reportPolicies[0].body).toMatch(/\bTO\s+authenticated\s+WITH\s+CHECK\s*\(/i);
        expect(reportPolicies[0].body).toMatch(
            /\breporter_id\s*=\s*\(\s*SELECT\s+auth\.uid\(\s*\)\s*\)\s*::\s*text\b/i,
        );
        expect(reportPolicies[0].body).not.toMatch(/\bOR\b/);
    });
});
