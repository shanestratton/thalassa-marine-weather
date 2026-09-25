import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

// Execute the actual handler with only synthetic records. APNs and Supabase
// are injected; these tests never read credentials or call a live service.
const edge = readFileSync('supabase/functions/send-anchor-alarm/index.ts', 'utf8');
const handlerSource = ts.transpileModule(edge.slice(edge.indexOf('// ---------- MAIN HANDLER')), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const incidentId = '00000000-0000-0000-0000-000000000001';
const tokenId = '00000000-0000-0000-0000-000000000011';

function harness() {
    const event = {
        id: incidentId,
        incident_id: incidentId,
        session_code: 'ABCDEFGH2345',
        user_id: 'synthetic-owner',
        pi_relay_id: 'synthetic-relay',
        alarm_kind: 'drag',
        distance_m: 70,
        swing_radius_m: 50,
        created_at: new Date().toISOString(),
        resolved_at: null as string | null,
        notified_device_tokens: [] as string[],
    };
    const tokens = [{ id: tokenId, device_token: 'synthetic-token', platform: 'ios', supports_reminders: true }];
    const claim = { incident_id: incidentId, claim_id: 'synthetic-claim', incident_started_at: event.created_at };
    const binding = {
        relay_id: event.pi_relay_id,
        last_heartbeat_at: new Date().toISOString(),
        gps_available: true,
        is_dragging: true,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
    };
    const rpc = vi.fn(async (name: string, ..._args: unknown[]): Promise<{ data: unknown; error: unknown }> => {
        if (name === 'claim_anchor_alarm_event') return { data: event, error: null };
        if (name === 'claim_anchor_alarm_delivery') return { data: claim, error: null };
        return { data: true, error: null };
    });
    const updates: Array<{ table: string; value: Record<string, unknown> }> = [];
    const querySteps: Array<[string, string, ...unknown[]]> = [];
    const from = vi.fn((table: string) => {
        let updating = false;
        const result = () => {
            if (updating) return { data: null, error: null };
            if (table === 'anchor_alarm_events') return { data: event, error: null };
            if (table === 'anchor_watch_sessions')
                return { data: { expires_at: new Date(Date.now() + 3600_000).toISOString() }, error: null };
            if (table === 'anchor_alarm_tokens') return { data: tokens, error: null };
            if (table === 'pi_anchor_sessions')
                return {
                    data: [binding],
                    error: null,
                };
            if (table === 'pi_diary_relays') return { data: { enabled: true }, error: null };
            throw new Error(`Unexpected table ${table}`);
        };
        const builder = {
            select: (..._args: unknown[]) => builder,
            eq: (...args: unknown[]) => {
                querySteps.push([table, 'eq', ...args]);
                return builder;
            },
            is: (..._args: unknown[]) => builder,
            limit: (...args: unknown[]) => {
                querySteps.push([table, 'limit', ...args]);
                return builder;
            },
            maybeSingle: () => Promise.resolve(result()),
            update: (value: Record<string, unknown>) => {
                updating = true;
                updates.push({ table, value });
                return builder;
            },
            then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
                Promise.resolve(result()).then(resolve, reject),
        };
        return builder;
    });
    const send = vi.fn(async (..._args: unknown[]) => true);
    let handler!: (request: Request) => Promise<Response>;
    new Function(
        'serve',
        'Deno',
        'createClient',
        'sendApnsPush',
        'anchorAlarmMessage',
        'internalServerErrorResponse',
        handlerSource,
    )(
        (callback: typeof handler) => {
            handler = callback;
        },
        {
            env: {
                get: (name: string) =>
                    name === 'SUPABASE_SERVICE_ROLE_KEY' ? 'synthetic-service-role' : 'https://example.invalid',
            },
        },
        () => ({ from, rpc }),
        send,
        () => ({ title: 'ANCHOR DRAG', body: 'Original distance 70m', kind: 'drag' }),
        () => new Response('Server error', { status: 500 }),
    );
    const run = async (reminder = true) =>
        handler(
            new Request('https://example.invalid', {
                method: 'POST',
                headers: { authorization: 'Bearer synthetic-service-role', 'content-type': 'application/json' },
                body: JSON.stringify({ record: { id: incidentId }, reminder }),
            }),
        );
    return { run, event, tokens, claim, binding, rpc, updates, send, querySteps };
}

describe('Shore Watch alarm reminders', () => {
    it('selects the event’s exact relay before limiting a multi-relay session', async () => {
        const h = harness();
        await h.run();
        const steps = h.querySteps.filter(([table]) => table === 'pi_anchor_sessions');
        expect(steps.slice(-2)).toEqual([
            ['pi_anchor_sessions', 'eq', 'relay_id', h.event.pi_relay_id],
            ['pi_anchor_sessions', 'limit', 1],
        ]);
    });

    it('claims and revalidates one device then sends immutable incident identity', async () => {
        const h = harness();
        const response = await h.run();
        expect(response.status).toBe(200);
        expect(h.rpc).toHaveBeenCalledWith('claim_anchor_alarm_delivery', {
            p_event_id: incidentId,
            p_token_id: tokenId,
        });
        expect(h.rpc).toHaveBeenCalledWith('anchor_alarm_delivery_is_current', {
            p_incident_id: incidentId,
            p_token_id: tokenId,
            p_claim_id: 'synthetic-claim',
        });
        expect(h.send).toHaveBeenCalledTimes(1);
        const data = h.send.mock.calls[0][3] as Record<string, unknown>;
        expect(data).toMatchObject({
            incident_id: incidentId,
            token_id: tokenId,
            incident_started_at: h.event.created_at,
        });
        expect(data).not.toHaveProperty('distance_m');
        expect(h.send.mock.calls[0][2]).not.toContain('70m');
        expect(h.rpc).toHaveBeenCalledWith('finish_anchor_alarm_delivery', {
            p_incident_id: incidentId,
            p_token_id: tokenId,
            p_claim_id: 'synthetic-claim',
            p_accepted: true,
        });
        expect(h.updates).toHaveLength(0);
        expect(h.rpc.mock.calls.some(([name]) => name === 'claim_anchor_alarm_event')).toBe(false);
    });

    it('never turns legacy phones into repeating devices', async () => {
        const h = harness();
        h.tokens[0].supports_reminders = false;
        expect((await h.run()).status).toBe(200);
        expect(h.send).not.toHaveBeenCalled();
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('keeps the original one-shot path for legacy phones', async () => {
        const h = harness();
        h.tokens[0].supports_reminders = false;
        expect((await h.run(false)).status).toBe(200);
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(h.rpc).toHaveBeenCalledWith('claim_anchor_alarm_event', { p_id: incidentId });
        expect(h.rpc.mock.calls.some(([name]) => name === 'claim_anchor_alarm_delivery')).toBe(false);
        expect(h.updates.some(({ value }) => typeof value.notified_at === 'string')).toBe(true);
    });

    it('does not resend an ACKed/not-due/already-claimed device', async () => {
        const h = harness();
        h.rpc.mockImplementation(async (name) => ({
            data: name === 'claim_anchor_alarm_delivery' ? null : true,
            error: null,
        }));
        expect((await h.run()).status).toBe(200);
        expect(h.send).not.toHaveBeenCalled();
    });

    it('preserves the accepted phone while leaving a partial original delivery retryable', async () => {
        const h = harness();
        h.tokens.push({ ...h.tokens[0], id: 'second-token-id', device_token: 'second-synthetic-token' });
        h.send.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect((await h.run(false)).status).toBe(502);
        expect(h.updates).toContainEqual({
            table: 'anchor_alarm_events',
            value: { notified_device_tokens: ['synthetic-token'] },
        });
        expect(h.updates.some(({ value }) => 'notified_at' in value)).toBe(false);
        expect(
            h.updates.some(({ value }) => value.processing_at === null && typeof value.last_error === 'string'),
        ).toBe(true);
    });

    it('recovery or acknowledgement between claim and delivery suppresses APNs', async () => {
        const h = harness();
        h.rpc.mockImplementation(async (name) => ({
            data:
                name === 'claim_anchor_alarm_delivery'
                    ? h.claim
                    : name === 'anchor_alarm_delivery_is_current'
                      ? false
                      : true,
            error: null,
        }));
        expect((await h.run()).status).toBe(200);
        expect(h.send).not.toHaveBeenCalled();
        expect(h.rpc).toHaveBeenCalledWith('finish_anchor_alarm_delivery', {
            p_incident_id: incidentId,
            p_token_id: tokenId,
            p_claim_id: 'synthetic-claim',
            p_accepted: false,
        });
    });

    it('a claim database error fails closed, not into a legacy resend', async () => {
        const h = harness();
        h.rpc.mockImplementation(async () => ({ data: null, error: { message: 'synthetic failure' } }));
        expect((await h.run()).status).toBe(502);
        expect(h.send).not.toHaveBeenCalled();
    });

    it('resolved original incident is never reopened by the reminder endpoint', async () => {
        const h = harness();
        h.event.resolved_at = new Date().toISOString();
        expect((await h.run()).status).toBe(200);
        expect(h.send).not.toHaveBeenCalled();
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('a transiently stale heartbeat suppresses delivery without resolving the incident', async () => {
        const h = harness();
        h.binding.last_heartbeat_at = new Date(Date.now() - 40_000).toISOString();
        expect((await h.run(false)).status).toBe(200);
        expect(h.send).not.toHaveBeenCalled();
        expect(h.updates.some(({ value }) => 'resolved_at' in value)).toBe(false);
        expect(h.updates.some(({ value }) => value.processing_at === null)).toBe(true);
        h.binding.last_heartbeat_at = new Date().toISOString();
        expect((await h.run()).status).toBe(200);
        expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('loss of GPS during a drag does not falsely resolve that drag incident', async () => {
        const h = harness();
        h.binding.gps_available = false;
        expect((await h.run()).status).toBe(200);
        expect(h.send).not.toHaveBeenCalled();
        expect(h.updates.some(({ value }) => 'resolved_at' in value)).toBe(false);
    });
});
