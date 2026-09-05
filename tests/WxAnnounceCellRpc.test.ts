/**
 * Audit item 15: fleet-presence cells are announced through a validated RPC,
 * never written to wx_subscriptions directly.
 *
 * The old policies let any client INSERT/UPDATE the table: unbounded cells,
 * client-chosen timestamps, unbounded publisher work. The migration replaces
 * them with announce_wx_cell(text) — range-checked, server-stamped, capped —
 * and the client calls it. These contracts hold both halves to that.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellIdFor } from '../services/weather/wxPublished';

const strip = (s: string) =>
    s
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

describe('announce_wx_cell migration', () => {
    const sql = strip(readFileSync('supabase/migrations/20260905120000_wx_announce_cell_rpc.sql', 'utf8'));

    it('defines a SECURITY DEFINER RPC that stamps the time server-side', () => {
        expect(sql).toContain('CREATE OR REPLACE FUNCTION public.announce_wx_cell(p_cell text)');
        expect(sql).toContain('SECURITY DEFINER');
        expect(sql).toContain('SET search_path = pg_catalog, public');
        // The client can no longer choose last_seen_at.
        expect(sql).toMatch(/SET last_seen_at = now\(\)/);
        expect(sql).toMatch(/VALUES \(p_cell, now\(\)\)/);
    });

    it('range-checks the cell, not just its shape', () => {
        expect(sql).toContain("p_cell !~ '^-?\\d{1,4}_-?\\d{1,5}$'");
        expect(sql).toContain('lat_idx < -9000 OR lat_idx > 9000');
        expect(sql).toContain('lon_idx < -18000 OR lon_idx > 18000');
        expect(sql).toContain('lat_idx % 25 <> 0 OR lon_idx % 25 <> 0');
    });

    it('refuses NEW cells at the cap but always refreshes an existing one', () => {
        const refreshAt = sql.indexOf('UPDATE public.wx_subscriptions SET last_seen_at = now() WHERE cell_id = p_cell');
        const capAt = sql.indexOf('IF live_cells >= 20000 THEN');
        const insertAt = sql.indexOf('INSERT INTO public.wx_subscriptions');
        expect(refreshAt).toBeGreaterThan(0);
        expect(capAt).toBeGreaterThan(refreshAt);
        expect(insertAt).toBeGreaterThan(capAt);
    });

    it('closes the direct write path', () => {
        expect(sql).toContain('DROP POLICY IF EXISTS wx_subscriptions_announce ON public.wx_subscriptions;');
        expect(sql).toContain('DROP POLICY IF EXISTS wx_subscriptions_refresh ON public.wx_subscriptions;');
        expect(sql).toMatch(
            /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.wx_subscriptions\s+FROM anon, authenticated;/,
        );
        expect(sql).toContain(
            'GRANT EXECUTE ON FUNCTION public.announce_wx_cell(text) TO anon, authenticated, service_role;',
        );
    });
});

describe('client announce', () => {
    it('calls the RPC and never writes the table', () => {
        const src = strip(readFileSync('services/weather/wxPublished.ts', 'utf8'));
        expect(src).toContain("supabase.rpc('announce_wx_cell', { p_cell: cell })");
        expect(src).not.toContain(".from('wx_subscriptions')");
    });

    it('produces cells the RPC accepts: multiples of 25 inside the world range', () => {
        for (const [lat, lon] of [
            [-27.47, 153.03],
            [0, 0],
            [-89.9, -179.9],
            [89.9, 179.9],
            [-33.86, 151.2],
        ]) {
            const cell = cellIdFor(lat, lon);
            expect(cell).toMatch(/^-?\d{1,4}_-?\d{1,5}$/);
            const [la, lo] = cell.split('_').map(Number);
            expect(Math.abs(la % 25)).toBe(0); // Math.abs: -0 % 25 is -0, and Object.is(-0, 0) is false
            expect(Math.abs(lo % 25)).toBe(0);
            expect(la).toBeGreaterThanOrEqual(-9000);
            expect(la).toBeLessThanOrEqual(9000);
            expect(lo).toBeGreaterThanOrEqual(-18000);
            expect(lo).toBeLessThanOrEqual(18000);
        }
    });
});
