/**
 * A "deleted" chat message kept its body, and any channel member could read it.
 *
 * deleted_at was the only thing a soft delete changed, and chat_messages_visible
 * does not filter on it — so a removed message stayed SELECTable with its text
 * intact, and only the UI declined to show it (external audit 2026-09-05).
 *
 * The fix is in the trigger that already governs updates, and it is deliberately
 * NOT a row-hiding policy: Realtime only delivers an UPDATE the subscriber can
 * see, so hiding the row would leave every other phone showing the message
 * until reload. The body leaves the row instead; the tombstoned row still
 * travels to every subscriber.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20260905104000_chat_soft_delete_removes_body.sql', 'utf8');
const code = sql.replace(/^\s*--.*$/gm, '');
const fn = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION public.protect_chat_message_update()'));

describe('soft delete removes the body, server-side', () => {
    it('replaces the body at the moment deleted_at is first set', () => {
        expect(fn).toMatch(
            /IF OLD\.deleted_at IS NULL AND NEW\.deleted_at IS NOT NULL THEN\s*NEW\.message := '\[removed\]';/,
        );
    });

    it('does so BEFORE the immutability check, and the check still bites everywhere else', () => {
        const blank = fn.indexOf("NEW.message := '[removed]'");
        const immut = fn.indexOf('ELSIF NEW.message IS DISTINCT FROM OLD.message THEN');
        expect(blank).toBeGreaterThan(-1);
        expect(immut).toBeGreaterThan(blank);
        expect(fn.slice(immut, immut + 200)).toContain("RAISE EXCEPTION 'Message identity and content are immutable'");
    });

    it("the tombstone satisfies the table's length CHECK (1..4000)", () => {
        expect('[removed]'.length).toBeGreaterThanOrEqual(1);
        expect('[removed]'.length).toBeLessThanOrEqual(4000);
    });

    it('an author can still delete their own message, once, forward only', () => {
        expect(fn).toMatch(
            /OLD\.user_id = auth\.uid\(\)\s*AND OLD\.deleted_at IS NULL\s*AND NEW\.deleted_at IS NOT NULL/,
        );
    });

    it('keeps every other rule of the live trigger intact', () => {
        for (const anchor of [
            'NEW.id IS DISTINCT FROM OLD.id',
            'NEW.channel_id IS DISTINCT FROM OLD.channel_id',
            "RAISE EXCEPTION 'Invalid helpful-count update'",
            'IF public.is_chat_moderator(auth.uid()) THEN RETURN NEW; END IF;',
            "RAISE EXCEPTION 'Only moderators may change message state'",
        ]) {
            expect(fn, anchor).toContain(anchor);
        }
    });

    it('does not hide the row — Realtime must still deliver the deletion', () => {
        expect(code).not.toMatch(/CREATE POLICY/);
        expect(code).not.toMatch(/deleted_at IS NULL\s*\)/);
    });

    it('needs no new trigger binding — the function name is unchanged', () => {
        expect(code).not.toContain('CREATE TRIGGER');
        expect(code).toContain('CREATE OR REPLACE FUNCTION public.protect_chat_message_update()');
    });
});
