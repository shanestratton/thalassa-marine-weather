/**
 * Handing the shore watch to the Pi (Shane 2026-08-29: "pi broadcaster first
 * then app side handoff").
 *
 * The rules that matter are about what happens when it DOESN'T work. A failed
 * handoff must degrade to the phone keeping the watch itself — never to no
 * watch at all — which is why nothing in this module throws.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('services/anchorPiHandoff.ts', 'utf8');
const relay = readFileSync('supabase/functions/anchor-relay/index.ts', 'utf8');
const migration = readFileSync('supabase/migrations/20260829090000_anchor_relay_sessions.sql', 'utf8');

describe('the order of the handoff', () => {
    it('authorises before assigning', () => {
        // A Pi that starts broadcasting into an unauthorised channel just
        // collects 403s, and the skipper's first symptom is a shore watch
        // that silently does not work.
        const fn = src.slice(src.indexOf('export async function handOffToPi'));
        expect(fn.indexOf('authoriseRelay')).toBeLessThan(fn.indexOf('assignWatchToPi'));
        expect(fn).toContain('if (!(await authoriseRelay(relayId, assignment.sessionCode))) return false;');
    });

    it('tells the Pi where the anchor is, because the Pi cannot know', () => {
        // The Pi has GPS and the bus; it does not know where the skipper
        // dropped the hook or how much rode went out.
        expect(src).toContain('anchorLat: number');
        expect(src).toContain('anchorLon: number');
        expect(src).toContain('swingRadius: number');
    });
});

describe('failure degrades to the phone, never to nothing', () => {
    it('returns false instead of throwing, on every path', () => {
        for (const fn of ['authoriseRelay', 'assignWatchToPi']) {
            const body = src.slice(src.indexOf(`export async function ${fn}`));
            expect(body.slice(0, body.indexOf('\n}\n'))).toContain('return false;');
        }
        expect(src).not.toMatch(/throw new Error/);
    });

    it('treats a missing session as a failed handoff, not a crash', () => {
        expect(src).toContain('if (!token) return false;');
    });
});

describe('the authorisation is short-lived on purpose', () => {
    it('renews well inside the window the relay grants', () => {
        // Six hours granted, renewed hourly: a missed refresh is survivable
        // and a sleeping phone does not end the watch.
        expect(src).toContain('export const RENEW_INTERVAL_MS = 60 * 60 * 1000;');
        expect(relay).toContain('const AUTHORISATION_TTL_MS = 6 * 60 * 60 * 1000;');
    });

    it('leans on expiry rather than on remembering to revoke', () => {
        // clearWatchOnPi is best effort; the lapse is what actually stops a
        // Pi that never got the message.
        const clear = src.slice(src.indexOf('export async function clearWatchOnPi'));
        expect(clear.slice(0, 400)).toContain('catch');
        expect(migration).toContain('pi_anchor_sessions_expiry_bounded');
    });
});

describe('transports are chosen deliberately', () => {
    it('reaches the Pi over the pinned boat-LAN channel', () => {
        // The Pi is a local device on the boat network, not a cloud endpoint.
        expect(src).toContain("import { pinnedPiRequest } from './PiPairingService';");
        expect(src).toContain('/api/anchor/watch');
    });

    it('authorises with the user session, which is the whole point of that call', () => {
        // getUser() on the far side is what proves the caller owns this relay.
        expect(src).toContain('supabase.auth.getSession()');
        expect(src).toContain('Authorization: `Bearer ${token}`');
        expect(relay).toContain('relay.owner_id !== ownerId');
    });
});
