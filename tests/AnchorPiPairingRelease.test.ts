/**
 * The anchor dashboard pairing outlived the person it belonged to.
 *
 * `anchor_pi_endpoint`, `anchor_pi_token` and `anchor_pi_outbox` are
 * unscoped Capacitor Preferences keys: a Bearer token and the endpoint of a
 * device that receives WHERE THE BOAT IS LYING, plus a queue of exactly those
 * positions. They predate the auth-scoped key convention, so the deletion
 * sweep — which matches keys by auth-scope suffix — could not see them, and
 * nothing cleared them on sign-out either.
 *
 * The consequence, from the deletion audit of 2026-08-28: the next account to
 * sign in on that handset inherits the pairing and pushes ITS anchor
 * positions to the previous owner's dashboard.
 *
 * Shane 2026-08-29: "ok fix that issue".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const push = readFileSync('services/anchorPiPush.ts', 'utf8');
const authStore = readFileSync('stores/authStore.ts', 'utf8');
const deletion = readFileSync('services/accountDeletion.ts', 'utf8');

describe('signing out releases the pairing', () => {
    it('clears it alongside the other per-user device state', () => {
        // The same allSettled that releases the push token, the Apple
        // credential and the local database.
        const teardown = authStore.slice(authStore.indexOf('const results = await Promise.allSettled(['));
        const block = teardown.slice(0, teardown.indexOf(']);'));
        expect(block).toContain('clearAnchorPiConfig()');
        expect(block).toContain('PushNotificationService.clearUser()');
    });

    it('imports it from the service that owns the keys', () => {
        expect(authStore).toContain("import { clearAnchorPiConfig } from '../services/anchorPiPush';");
    });
});

describe('clearing takes the queue with it', () => {
    it('removes the outbox, not just the credentials', () => {
        // The outbox holds anchor positions addressed to a device this
        // handset is no longer paired with. Left queued, the next successful
        // flush sends one skipper's anchorage to another's dashboard.
        const fn = push.slice(push.indexOf('export async function clearAnchorPiConfig'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        expect(body).toContain('ENDPOINT_KEY');
        expect(body).toContain('TOKEN_KEY');
        expect(body).toContain('OUTBOX_KEY');
    });
});

describe('account deletion sweeps them', () => {
    it('lists all three as unscoped secrets', () => {
        const list = deletion.slice(deletion.indexOf('const NATIVE_UNOWNED_SECRET_KEYS = ['));
        const block = list.slice(0, list.indexOf('] as const;'));
        expect(block).toContain("'anchor_pi_endpoint'");
        expect(block).toContain("'anchor_pi_token'");
        expect(block).toContain("'anchor_pi_outbox'");
    });

    it('is on the explicit list, because the suffix sweep cannot reach them', () => {
        // purgeNativePreferences only removes keys ending in the auth scope
        // suffix. Unscoped keys need naming, exactly like the Gmail tokens.
        expect(deletion).toContain('candidate.endsWith(suffix)');
        expect(deletion).toContain("'calypso:gmail:access_token'");
        expect(deletion).toContain('for (const key of NATIVE_UNOWNED_SECRET_KEYS) await Preferences.remove({ key });');
    });
});

describe('the keys themselves are unchanged', () => {
    it('still reads and writes the same three names', () => {
        // The fix is about lifecycle, not storage layout — an existing pairing
        // keeps working until the skipper signs out.
        expect(push).toContain("const ENDPOINT_KEY = 'anchor_pi_endpoint';");
        expect(push).toContain("const TOKEN_KEY = 'anchor_pi_token';");
        expect(push).toContain("const OUTBOX_KEY = 'anchor_pi_outbox';");
    });

    it('still refuses to send a boat position over plaintext', () => {
        expect(push).toContain("if (!url.startsWith('https://'))");
    });
});
