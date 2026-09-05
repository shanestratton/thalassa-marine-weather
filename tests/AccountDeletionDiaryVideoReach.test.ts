/**
 * Diary video was outside the deletion reach.
 *
 * account_deletion_storage_inventory() certifies storage clean when it returns
 * no rows, and its path-based bucket list — six buckets — was written before
 * diary-video existed and never revisited. The owner_id branch caught clips the
 * phone uploaded itself; it cannot catch one the PI uploaded on the phone's
 * behalf (DiaryService._parkVideoOnPi), which lands with the Pi's credentials,
 * owner_id null, under the punter's uid — exactly the shape the list exists to
 * catch, in exactly the bucket missing from it. block_tombstoned_storage_write()
 * shares the list, so a tombstoned account could write a clip back.
 *
 * The migration is generated from the LIVE production function bodies
 * (pg_get_functiondef, 2026-09-05) with one line added to each list, so it
 * cannot regress anything a later migration did to either function.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260905100000_deletion_reach_diary_video.sql', 'utf8');

function body(fn: string): string {
    const at = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    expect(at, `${fn} must be redefined`).toBeGreaterThan(-1);
    const next = sql.indexOf('CREATE OR REPLACE FUNCTION', at + 1);
    return sql.slice(at, next === -1 ? undefined : next);
}

describe('diary video is inside the deletion reach', () => {
    it('adds diary-video to the inventory beside the other diary buckets', () => {
        const inv = body('account_deletion_storage_inventory');
        expect(inv).toMatch(/'diary-photos',\s*'diary-audio',\s*'diary-video',/);
        // Path-based, uid at segment 1 — the shape a Pi-parked clip has.
        expect(inv).toContain("split_part(object.name, '/', 1) = p_user_id::TEXT");
    });

    it('adds it to the tombstone write fence too — the same six-bucket list', () => {
        const fence = body('block_tombstoned_storage_write');
        expect(fence).toMatch(/'diary-photos',\s*'diary-audio',\s*'diary-video',/);
    });

    it('keeps every bucket that was already covered', () => {
        for (const bucket of [
            'crew-list-photos',
            'diary-photos',
            'diary-audio',
            'vessel_vault',
            'marketplace-images',
            'recipe-photos',
            'chat-avatars',
            'enc-cells',
        ]) {
            expect(body('account_deletion_storage_inventory'), bucket).toContain(`'${bucket}'`);
        }
    });

    it('redefines exactly the two functions and nothing else', () => {
        expect((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length).toBe(2);
        expect(sql).not.toMatch(/\bDROP\b/);
    });
});
