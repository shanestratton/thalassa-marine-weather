/**
 * Every column a Stores item sends is declared by a migration (126-B9c;
 * binder audit 2026-10-09: STORES-02).
 *
 * The app sends expiry_date with every Stores insert (types/vessel.ts
 * StoresItem, InventoryScanner, the edit sheet), and the sync engine upserts
 * the whole payload, so a column the table lacks is PGRST204 and a fenced
 * outbox item. No migration ever added expiry_date to inventory_items: live
 * has it (a nullable DATE, verified read-only 2026-10-10) only because it was
 * added by hand. 20261010152000 records it, so a database built from the
 * migrations alone (a branch, a restore, a new project) matches live. On live
 * it is a no-op.
 *
 * These checks pin the migration TEXT, in the OfflineSchemaAlignmentMigration
 * pattern. The file is pushed by Shane with the 126 release, never by a builder.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/migrations';
const FILE = '20261010152000_inventory_items_expiry_date.sql';
const migrations = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

const read = (file: string): string => (migrations.includes(file) ? readFileSync(`${DIR}/${file}`, 'utf8') : '');
const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/** The columns some migration creates or adds on public.inventory_items. */
function declaredInventoryColumns(): Set<string> {
    const columns = new Set<string>();
    for (const file of migrations) {
        const code = stripComments(read(file));
        // CREATE TABLE [IF NOT EXISTS] [public.]inventory_items ( … );
        for (const create of code.matchAll(
            /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?inventory_items\s*\(([\s\S]*?)\n\);/gi,
        )) {
            for (const line of create[1].split('\n')) {
                const column = line.trim().match(/^([a-z_]+)\s+[A-Z]/);
                if (column && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)$/i.test(column[1])) columns.add(column[1]);
            }
        }
        // ALTER TABLE [public.]inventory_items … ADD COLUMN [IF NOT EXISTS] name …;
        for (const statement of code.split(';')) {
            if (!/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?inventory_items\b/i.test(statement)) continue;
            for (const added of statement.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)/gi)) {
                columns.add(added[1]);
            }
        }
    }
    return columns;
}

/** The fields of StoresItem (types/vessel.ts), the shape every Stores insert sends. */
function storesItemFields(): string[] {
    const types = readFileSync('types/vessel.ts', 'utf8');
    const start = types.indexOf('export interface StoresItem {');
    const body = types.slice(start, types.indexOf('\n}', start));
    return [...body.matchAll(/^\s+([a-z_]+)\??:/gm)].map((match) => match[1]);
}

describe('Stores columns: the client and the migrations agree (STORES-02)', () => {
    const declared = declaredInventoryColumns();

    it('the parser sees the base table and the later ALTERs', () => {
        // Sanity: the base table (20260219000000) and three later ALTERs.
        for (const column of ['item_name', 'quantity', 'location_zone', 'unit', 'currency', 'unit_system', 'notes']) {
            expect(declared, column).toContain(column);
        }
    });

    it.each([
        'id',
        'user_id',
        'barcode',
        'item_name',
        'description',
        'category',
        'quantity',
        'min_quantity',
        'unit',
        'currency',
        'unit_value',
        'unit_system',
        'location_zone',
        'location_specific',
        'expiry_date',
    ])('%s, which the client sends on INSERT, is added by a migration', (column) => {
        expect(declared).toContain(column);
    });

    it('so is every field StoresItem declares', () => {
        const fields = storesItemFields();
        expect(fields).toContain('expiry_date');
        expect(fields.filter((field) => !declared.has(field))).toEqual([]);
    });
});

describe(`${FILE}`, () => {
    const sql = read(FILE);
    const code = stripComments(sql);
    const body = code.replace(/\s+/g, ' ').trim();
    const first = sql.search(/^\s*(?!--)\S/m);
    const header = first > 0 ? sql.slice(0, first) : '';

    it('exists, sorts after the 126-19 repairs, and has its version to itself', () => {
        expect(migrations).toContain(FILE);
        expect(FILE > '20261010151900_check_weather_alerts_reschedule.sql').toBe(true);
        expect(migrations.filter((name) => name.startsWith('20261010152000_'))).toEqual([FILE]);
    });

    it('adds a nullable DATE expiry_date, idempotently, and nothing else', () => {
        expect(body).toContain('ALTER TABLE public.inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE;');
        expect(body).not.toMatch(/expiry_date DATE (NOT NULL|DEFAULT)/i);
        expect(body).not.toMatch(/TIMESTAMPTZ|timestamp with time zone/i);
        // No backfill, no RLS or publication change, no grants.
        expect(body).not.toMatch(/\bGRANT\b|\bREVOKE\b|\bPOLICY\b|\bPUBLICATION\b|\bUPDATE public\./i);
        expect(body).not.toMatch(/\bDROP\b/i);
        expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im);
    });

    it('bounds its lock, and ends with a self-check that fails the push', () => {
        expect(body.startsWith("SET lock_timeout = '5s';")).toBe(true);
        expect(body.endsWith('RESET lock_timeout;')).toBe(true);
        const check = body.slice(body.indexOf('DO $check$'), body.indexOf('$check$;') + '$check$;'.length);
        expect(check).toContain("table_name = 'inventory_items'");
        expect(check).toContain("column_name = 'expiry_date'");
        expect(check).toContain("data_type = 'date'");
        expect(check).toContain("is_nullable = 'YES'");
        expect(check).toContain(
            "has_column_privilege('authenticated', 'public.inventory_items', 'expiry_date', 'INSERT')",
        );
        expect(check).toContain(
            "has_column_privilege('authenticated', 'public.inventory_items', 'expiry_date', 'UPDATE')",
        );
        expect(check).toMatch(/RAISE EXCEPTION 'inventory_items_expiry_date: /);
        expect(body.endsWith(`${check} RESET lock_timeout;`)).toBe(true);
    });

    it('says it is a no-op on live, why it exists, and never that sync is blocked', () => {
        expect(header).toMatch(/126-B9c/);
        expect(header).toMatch(/STORES-02/);
        expect(header).toMatch(/no-op on live/i);
        expect(header).toMatch(/added by hand/i);
        expect(header).toMatch(/Not pushed/);
        expect(header).not.toMatch(/sync is blocked|blocks? (Stores )?sync|never synced|fails? to sync/i);
    });
});
