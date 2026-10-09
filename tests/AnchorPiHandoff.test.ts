/**
 * Handing the shore watch to the Pi (Shane 2026-08-29: "pi broadcaster first
 * then app side handoff").
 *
 * The rules that matter are about what happens when it DOESN'T work. A failed
 * handoff must degrade to the phone keeping the watch itself — never to no
 * watch at all — which is why nothing in this module throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Stand-ins for the Pi's pinned transport, the Pi cache's addresses and the
// cloud session, so the module is CALLED below, not only read. Fictional
// addresses throughout.
const pi = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../services/PiPairingService', () => ({ pinnedPiRequest: (o: unknown) => pi.request(o) }));
vi.mock('../services/supabase', () => ({
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'fictional-jwt' } } }) } },
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        getStatus: () => ({ reachable: true, lastCheck: 0, latencyMs: 0, diaryRelayId: 'relay-lyttelton' }),
        getBaseUrl: () => 'https://192.168.40.2:3001',
        getRemoteBaseUrl: () => null,
        ping: async () => ({}),
    },
}));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));

import { assignWatchToPi, type PiWatchAssignment } from '../services/anchorPiHandoff';

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

// 126-07a, D4: pinnedPiRequest RETURNS a 400, 409 or 500; it throws only when
// the transport fails. Counting any answer as taken meant a Pi saying "409:
// not paired" was believed to be keeping the watch, at the handoff and at
// every hourly renewal, and a moved mark would have read "moved" while the Pi
// kept the old one. Success is a 2xx and nothing else.
describe('the Pi has taken the watch only when it says so (HTTP 2xx)', () => {
    // Off Lyttelton, New Zealand (fictional watch).
    const assignment: PiWatchAssignment = {
        sessionCode: 'LYTTELTON123',
        anchorLat: -43.61,
        anchorLon: 172.72,
        swingRadius: 38,
        rodeLength: 35,
        waterDepth: 6,
    };
    const reply = (status: number, body: unknown = { status: status < 300 ? 'ok' : 'error' }) => ({
        status,
        headers: {},
        data: typeof body === 'string' ? body : JSON.stringify(body),
        peerSpki: '',
    });

    beforeEach(() => {
        pi.request.mockReset();
        vi.stubEnv('VITE_SUPABASE_URL', 'https://fictional-project.supabase.co');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('{}', { status: 200 })),
        );
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('is true on 200', async () => {
        pi.request.mockResolvedValue(reply(200));
        expect(await assignWatchToPi(assignment, 'https://192.168.40.2:3001')).toBe(true);
        expect(pi.request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://192.168.40.2:3001/api/anchor/watch',
                method: 'POST',
                data: assignment,
            }),
        );
    });

    it.each([
        [400, { status: 'error', error: 'swingRadius must be between 5 and 5000 metres' }],
        [409, { status: 'error', error: 'This Pi is not paired to an account, so it cannot relay a watch' }],
        [500, 'Internal Server Error'],
    ])('is false on %i, without throwing', async (status, body) => {
        pi.request.mockResolvedValue(reply(status, body));
        await expect(assignWatchToPi(assignment, 'https://192.168.40.2:3001')).resolves.toBe(false);
    });

    it('is false when the transport fails', async () => {
        pi.request.mockRejectedValue(new Error('The request timed out.'));
        await expect(assignWatchToPi(assignment, 'https://192.168.40.2:3001')).resolves.toBe(false);
    });

    it('begin() with a 409 returns false: the phone keeps the watch', async () => {
        pi.request.mockResolvedValue(
            reply(409, { status: 'error', error: 'This Pi has no Supabase anon key configured' }),
        );
        vi.resetModules();
        const { AnchorPiWatchKeeper } = await import('../services/anchorPiWatchKeeper');
        expect(await AnchorPiWatchKeeper.begin(assignment)).toBe(false);
        expect(AnchorPiWatchKeeper.isKeeping()).toBe(false);
    });
});
