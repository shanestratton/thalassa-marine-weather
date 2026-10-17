/** Executes the actual Edge handler with a fake service boundary; no network. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { validAnchorGps } from '../supabase/functions/_shared/anchor-alarm';
import { parseAnchorBoundary } from '../supabase/functions/_shared/anchorSafeZone';
import { validAreaReport, validAreaRevision, validAreaVessel } from '../supabase/functions/anchor-relay/safeArea';
const source = readFileSync('supabase/functions/anchor-relay/index.ts', 'utf8');
const compiled = ts
    .transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
    .outputText.replace(/^import[^;]+;\s*/gm, '');
const owner = '10000000-0000-4000-8000-000000000001',
    relay = 'fictional-anchor-relay139',
    code = 'Anchor139001';
const revision = '20000000-0000-4000-8000-000000000001';
const area = { version: 1, frame: { latitude: -27, longitude: 153, radiusM: 60 }, zone: null };
const binding = {
    owner_id: owner,
    session_code: code,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    safe_area: area,
    safe_area_revision: revision,
    safe_area_vessel_id: 'boat-a',
};
const payload = () => ({
    anchor: { latitude: -27, longitude: 153 },
    vessel: { latitude: -27, longitude: 153, timestamp: Date.now() },
    swingRadius: 60,
    isAlarm: false,
    safeZone: null,
    safeAreaRevision: revision,
    safeAreaVesselId: 'boat-a',
});
function setup(patch: Record<string, unknown> = {}, rpcResult: unknown = { expires_at: binding.expires_at }) {
    let handler!: (req: Request) => Promise<Response>;
    const state = {
        binding: { ...binding },
        relay: {
            owner_id: owner,
            enabled: true,
            token_hash: createHash('sha256').update('fixture-token').digest('hex'),
        },
        session: { owner_user_id: owner, expires_at: binding.expires_at },
        ...patch,
    };
    const rpc = vi.fn(async () => ({ data: rpcResult, error: null })),
        fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const admin = {
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: owner } }, error: null })) },
        rpc,
        from: vi.fn((table: string) => {
            const answer = {
                data:
                    table === 'pi_diary_relays'
                        ? state.relay
                        : table === 'anchor_watch_sessions'
                          ? state.session
                          : state.binding,
                error: null,
            };
            const query: any = {
                select: () => query,
                eq: () => query,
                maybeSingle: async () => answer,
                update: () => query,
                then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
            };
            return query;
        }),
    };
    vm.runInNewContext(compiled, {
        Deno: {
            env: {
                get: (key: string) =>
                    key === 'ANCHOR_SAFE_AREA_ADMISSION'
                        ? patch.admission === true
                            ? 'enabled-after-drain'
                            : undefined
                        : key === 'SUPABASE_URL'
                          ? 'https://fixture.invalid'
                          : 'fixture-service-not-a-real-key',
            },
            serve: (fn: typeof handler) => {
                handler = fn;
            },
        },
        createClient: () => admin,
        validAnchorGps,
        parseAnchorBoundary,
        validAreaReport,
        validAreaRevision,
        validAreaVessel,
        crypto: webcrypto,
        TextEncoder,
        Request,
        Response,
        Date,
        console: { error: vi.fn() },
        fetch,
    });
    const invoke = (body: Record<string, unknown>) =>
        handler(
            new Request('https://fixture.invalid/anchor-relay', {
                method: 'POST',
                headers: { Authorization: 'Bearer fixture-user-token' },
                body: JSON.stringify({ relay_id: relay, session_code: code, token: 'fixture-token', ...body }),
            }),
        );
    return { invoke, rpc, fetch, state, admin };
}
describe('actual anchor relay atomic area boundary', () => {
    it('holds custom admission by default until the release-owner drain gate is explicitly enabled', async () => {
        const custom = {
            ...area,
            zone: {
                version: 1,
                kind: 'wedges',
                anchor: { latitude: -27, longitude: 153 },
                exclusions: [{ startDeg: 0, sweepDeg: 45 }],
            },
        };
        const body = {
            action: 'authorise',
            safe_area: custom,
            safe_area_revision: revision,
            safe_area_vessel_id: 'boat-a',
        };
        const held = setup({ binding: { ...binding, safe_area: custom } }),
            response = await held.invoke(body);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'safe_area_not_enabled' });
        expect(held.rpc).not.toHaveBeenCalled();
        expect(held.fetch).not.toHaveBeenCalled();
        expect(held.state.binding.safe_area).toEqual(custom);
        const clear = setup({}, { authorised: true, safe_area: area, safe_area_revision: revision });
        expect((await clear.invoke({ ...body, safe_area: area })).status).toBe(200);
        expect(clear.rpc).toHaveBeenCalledWith(
            'authorise_pi_anchor_area',
            expect.objectContaining({ p_explicit_area: true, p_safe_area: area }),
        );
        const enabled = setup(
            { admission: true },
            { authorised: true, safe_area: custom, safe_area_revision: revision },
        );
        expect((await enabled.invoke(body)).status).toBe(200);
        expect(enabled.rpc).toHaveBeenCalledWith(
            'authorise_pi_anchor_area',
            expect.objectContaining({ p_explicit_area: true, p_safe_area: custom }),
        );
    });
    it('passes the exact read identity to the atomic heartbeat and publishes only after acceptance', async () => {
        const h = setup(),
            response = await h.invoke({ payload: payload() });
        expect(response.status).toBe(200);
        expect(h.rpc).toHaveBeenCalledWith(
            'record_pi_anchor_area_heartbeat',
            expect.objectContaining({
                p_owner_id: owner,
                p_session_code: code,
                p_safe_area: area,
                p_safe_area_revision: revision,
                p_safe_area_vessel_id: 'boat-a',
            }),
        );
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.rpc.mock.invocationCallOrder[0]).toBeLessThan(h.fetch.mock.invocationCallOrder[0]);
    });
    it('does not publish a report retired by the database after its earlier read', async () => {
        const h = setup({}, null),
            response = await h.invoke({ payload: payload() });
        expect(response.status).toBe(403);
        expect(h.rpc).toHaveBeenCalledTimes(1);
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('retains actual legacy circle reports without minting new area metadata', async () => {
        const h = setup({
            binding: { ...binding, safe_area: null, safe_area_revision: null, safe_area_vessel_id: null },
        });
        const p = payload();
        delete (p as any).safeAreaRevision;
        delete (p as any).safeAreaVesselId;
        expect((await h.invoke({ payload: p })).status).toBe(200);
        expect(h.rpc).toHaveBeenCalledWith(
            'record_pi_anchor_area_heartbeat',
            expect.objectContaining({ p_safe_area: null, p_safe_area_revision: null, p_safe_area_vessel_id: null }),
        );
    });
    it.each(['owner', 'session', 'expiry', 'revision'] as const)(
        'refuses a wrong %s before renewal or publication',
        async (kind) => {
            const h = setup(
                kind === 'owner'
                    ? { binding: { ...binding, owner_id: 'other' } }
                    : kind === 'session'
                      ? { binding: { ...binding, session_code: 'Other1390001' } }
                      : kind === 'expiry'
                        ? { binding: { ...binding, expires_at: '2020-01-01T00:00:00Z' } }
                        : {},
            );
            const p = payload();
            if (kind === 'revision') p.safeAreaRevision = 'old';
            expect((await h.invoke({ payload: p })).status).toBe(kind === 'revision' ? 409 : 403);
            expect(h.rpc).not.toHaveBeenCalled();
            expect(h.fetch).not.toHaveBeenCalled();
        },
    );
    it('returns the database-current B area to a legacy renewal rather than echoing the stale A read', async () => {
        const b = {
            authorised: true,
            safe_area: { ...area, frame: { ...area.frame, radiusM: 65 } },
            safe_area_revision: '20000000-0000-4000-8000-000000000002',
        };
        const h = setup({}, b),
            response = await h.invoke({ action: 'authorise' });
        expect(await response.json()).toEqual(b);
        expect(h.rpc).toHaveBeenCalledWith(
            'authorise_pi_anchor_area',
            expect.objectContaining({ p_expected: binding, p_explicit_area: false, p_safe_area: null }),
        );
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('holds a concurrent explicit clear conflict without falsely acknowledging its proposed area', async () => {
        const h = setup({}, { conflict: true }),
            response = await h.invoke({
                action: 'authorise',
                safe_area: area,
                safe_area_revision: revision,
                safe_area_vessel_id: null,
            });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'safe_area_authorisation_conflict' });
    });
    it('a stale stop cannot report success or clear alarms in a second unchecked write', async () => {
        const h = setup({}, false),
            response = await h.invoke({ action: 'stop' });
        expect(response.status).toBe(409);
        expect(h.rpc).toHaveBeenCalledWith(
            'stop_pi_anchor_area',
            expect.objectContaining({ p_expected: binding, p_session_code: code }),
        );
        expect(h.fetch).not.toHaveBeenCalled();
        expect(h.admin.from).not.toHaveBeenCalledWith('anchor_alarm_events');
    });
});
