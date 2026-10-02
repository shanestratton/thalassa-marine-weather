/**
 * Realtime delivers postgres_changes only for tables in the supabase_realtime
 * publication. The binder pages subscribed to five tables no migration had
 * ever published, so the socket stayed silent for them (review, 2026-10-02).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/migrations';
const BINDER_TABLES = [
    'inventory_items',
    'maintenance_tasks',
    'maintenance_history',
    'equipment_register',
    'ship_documents',
];
const migration = readFileSync(`${DIR}/20261002150000_binder_realtime_publication.sql`, 'utf8');

/** Every table some migration adds to supabase_realtime. */
function publishedTables(): Set<string> {
    const published = new Set<string>();
    for (const file of readdirSync(DIR).filter((name) => name.endsWith('.sql'))) {
        const sql = readFileSync(`${DIR}/${file}`, 'utf8');
        if (!/supabase_realtime/i.test(sql)) continue;
        for (const match of sql.matchAll(/ADD TABLE\s+(?:public\.)?([a-z_]+)/gi)) published.add(match[1]);
        // The binder migration adds its tables from a list.
        const list = sql.match(/FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\]/i);
        if (list) for (const match of list[1].matchAll(/'([a-z_]+)'/g)) published.add(match[1]);
    }
    return published;
}

/** Every table a page subscribes to through useRealtimeSync(Multi). */
function subscribedTables(): Set<string> {
    const subscribed = new Set<string>();
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) walk(path);
            else if (/\.tsx?$/.test(entry.name)) {
                const source = readFileSync(path, 'utf8');
                for (const match of source.matchAll(/useRealtimeSync\(\s*'([a-z_]+)'/g)) subscribed.add(match[1]);
                for (const match of source.matchAll(/useRealtimeSyncMulti\(\s*\[([^\]]*)\]/g)) {
                    for (const table of match[1].matchAll(/'([a-z_]+)'/g)) subscribed.add(table[1]);
                }
            }
        }
    };
    walk('components');
    walk('pages');
    return subscribed;
}

describe('binder realtime publication migration', () => {
    it('adds each binder table to supabase_realtime, guarded so a dashboard-added table is left alone', () => {
        const list = migration.match(/ARRAY\[([\s\S]*?)\]/)?.[1] ?? '';
        expect([...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])).toEqual(BINDER_TABLES);
        expect(migration).toMatch(/FROM pg_publication\s+WHERE pubname = 'supabase_realtime'/);
        expect(migration).toMatch(/NOT EXISTS \([\s\S]+FROM pg_publication_tables[\s\S]+tablename = binder_table/);
        expect(migration).toMatch(/to_regclass\(format\('public\.%I', binder_table\)\) IS NOT NULL/);
        expect(migration).toMatch(/ALTER PUBLICATION supabase_realtime ADD TABLE public\.%I', binder_table/);
    });

    it('leaves vessel_crew out: every DELETE would force a full pull on every open Vessel Hub', () => {
        const list = migration.match(/ARRAY\[([\s\S]*?)\]/)?.[1] ?? '';
        expect(list).not.toMatch(/vessel_crew/);
    });

    it('every table a page listens to is published by some migration (vessel_crew excepted, see above)', () => {
        const published = publishedTables();
        const unpublished = [...subscribedTables()].filter((table) => table !== 'vessel_crew' && !published.has(table));
        expect(unpublished).toEqual([]);
        for (const table of BINDER_TABLES) expect(published.has(table)).toBe(true);
    });
});
