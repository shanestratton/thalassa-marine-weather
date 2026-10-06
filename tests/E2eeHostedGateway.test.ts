import { describe, expect, it, vi } from 'vitest';
import {
    createHostedResearchGateway,
    createHostedResearchRpc,
    createSupabasePilotRuntimeHandler,
    validatePilotDatabaseUrl,
    PILOT_ORIGIN,
} from '../experiments/scuttlebutt-e2ee/relay/hostedGateway';

const user = '11111111-1111-4111-8111-111111111111';
const role = {
    login: 'e2ee_pilot_edge',
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolbypassrls: false,
    rolinherit: false,
};
function database(identity = role) {
    const query = vi.fn(async (statement: string) =>
        statement.startsWith('SELECT session_user')
            ? [identity]
            : statement.startsWith('SELECT e2ee_research.')
              ? [{ result: { accepted: true } }]
              : [],
    );
    const transaction = vi.fn(
        async <T>(body: (tx: { query: typeof query }) => Promise<T>): Promise<T> => await body({ query }),
    );
    return { query, transaction };
}
describe('isolated hosted signed gateway', () => {
    it.each(['register', 'dispatch'])(
        'maps only observed Supabase runtime %s while preserving request data',
        async (action) => {
            const handler = vi.fn(async (request: Request) => {
                expect(request.url).toBe(`${PILOT_ORIGIN}/functions/v1/scuttlebutt-e2ee-pilot/v1/${action}`);
                expect(request.method).toBe('POST');
                expect(request.headers.get('authorization')).toBe('Bearer fixture');
                expect(await request.text()).toBe('{}');
                return Response.json({ version: 1, result: true });
            });
            const adapter = createSupabasePilotRuntimeHandler(handler);
            const result = await adapter(
                new Request(`http://kmtupdvwdgbhtssqqova.supabase.co/scuttlebutt-e2ee-pilot/v1/${action}`, {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer fixture',
                        'content-type': 'application/json',
                        'x-forwarded-host': 'wrong.invalid',
                        host: 'wrong.invalid',
                    },
                    body: '{}',
                }),
            );
            expect(result.status).toBe(200);
            expect(handler).toHaveBeenCalledTimes(1);
        },
    );
    it.each([
        `${PILOT_ORIGIN}/functions/v1/scuttlebutt-e2ee-pilot/v1/register`,
        'http://other.supabase.co/scuttlebutt-e2ee-pilot/v1/register',
        'http://kmtupdvwdgbhtssqqova.supabase.co/scuttlebutt-e2ee-pilot/v1/register?x=1',
        'http://kmtupdvwdgbhtssqqova.supabase.co/scuttlebutt-e2ee-pilot/v1/register/',
        'http://kmtupdvwdgbhtssqqova.supabase.co/scuttlebutt-e2ee-pilot/v1/%72egister',
        'http://kmtupdvwdgbhtssqqova.supabase.co/scuttlebutt-e2ee-pilot/v1/unknown',
    ])('refuses an unobserved runtime URL %s before invoking gateway', async (url) => {
        const handler = vi.fn(async () => Response.json({ version: 1, result: true }));
        const response = await createSupabasePilotRuntimeHandler(handler)(new Request(url));
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(handler).not.toHaveBeenCalled();
    });
    it('redacts mounting failures and retains no-store/nosniff on the generic response', async () => {
        const handler = vi.fn(async () => {
            throw new Error('private-sentinel');
        });
        const response = await createSupabasePilotRuntimeHandler(handler)(
            new Request('http://kmtupdvwdgbhtssqqova.supabase.co/scuttlebutt-e2ee-pilot/v1/dispatch'),
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ version: 1, error: 'request-unresolved' });
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });
    it('accepts only a canonical dedicated-login DSN without leaking invalid secret URLs', () => {
        const dsn = `postgresql://e2ee_pilot_edge:${'a'.repeat(64)}@db.kmtupdvwdgbhtssqqova.supabase.co:5432/postgres`;
        expect(validatePilotDatabaseUrl(dsn)).toBe(dsn);
        for (const hostile of [
            undefined,
            'password-sentinel',
            dsn.replace(':5432/', ':password-sentinel/'),
            dsn.replace('e2ee_pilot_edge', 'postgres'),
            dsn.replace('kmtupdvwdgbhtssqqova', 'pcisdplnodrphauixcau'),
            `${dsn}?sslmode=disable`,
            `${dsn}#password-sentinel`,
            dsn.replace('postgresql:', 'postgres:'),
            dsn.replace('a'.repeat(64), 'password-sentinel'),
        ]) {
            try {
                validatePilotDatabaseUrl(hostile);
                throw new Error('fixture should refuse');
            } catch (error) {
                expect((error as Error).message).toBe('Hosted pilot request unresolved');
                expect((error as Error).stack).not.toContain('password-sentinel');
                expect((error as Error).stack).not.toContain('postgresql://');
            }
        }
    });
    it.each(['register_device', 'lookup_request_key', 'execute_request'] as const)(
        'parameterizes only %s under a transaction-local role',
        async (name) => {
            const db = database();
            const values =
                name === 'register_device'
                    ? [user, '{}']
                    : name === 'lookup_request_key'
                      ? [user, 'device']
                      : [user, 'device', 'request', 'list', '[0,16]', 100, '{}'];
            expect(await createHostedResearchRpc(db)(name, values)).toEqual({ accepted: true });
            expect(db.transaction).toHaveBeenCalledTimes(1);
            expect(db.query.mock.calls.map((call) => call[0]).slice(0, 6)).toEqual([
                'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
                "SET LOCAL statement_timeout = '4000ms'",
                "SET LOCAL lock_timeout = '1000ms'",
                "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
                'SELECT session_user AS login, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit FROM pg_catalog.pg_roles WHERE rolname = session_user',
                'SET LOCAL ROLE e2ee_research_gateway',
            ]);
            expect(db.query.mock.calls.at(-1)?.[0]).toContain(`e2ee_research.${name}($1::text`);
            expect(db.query).toHaveBeenLastCalledWith(expect.any(String), values);
        },
    );
    it.each(['require-protected', 'account-mode'] as const)(
        'binds signed %s to the exact configured execute_request transaction',
        async (action) => {
            const deviceId = 'hosted-device';
            const requestId = `hosted-${action}`;
            const expiresAt = 100;
            const result = {
                requestId,
                ownerUserId: user,
                ownerDeviceId: deviceId,
                mode: action === 'require-protected' ? 'protected-required' : 'legacy',
            };
            const statement =
                'SELECT e2ee_research.execute_request($1::text,$2::text,$3::text,$4::text,$5::text,$6::bigint,$7::text) AS result';
            const query = vi.fn(async (sql: string) =>
                sql.startsWith('SELECT session_user') ? [role] : sql === statement ? [{ result }] : [],
            );
            const transaction = vi.fn(
                async <T>(body: (tx: { query: typeof query }) => Promise<T>): Promise<T> => await body({ query }),
            );
            // Adapter fixture only: Auth and device-signature verification occur
            // in the signed gateway before this server-only SQL adapter.
            const wire = JSON.stringify({
                version: 1,
                protocol: 'olm-v1',
                userId: user,
                deviceId,
                action,
                requestId,
                expiresAt,
                payload: '[]',
                signature: 'A'.repeat(86),
            });
            const values = [user, deviceId, requestId, action, '[]', expiresAt, wire] as const;
            expect(await createHostedResearchRpc({ transaction })('execute_request', values)).toEqual(result);
            expect(transaction).toHaveBeenCalledTimes(1);
            expect(query.mock.calls).toEqual([
                ['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', []],
                ["SET LOCAL statement_timeout = '4000ms'", []],
                ["SET LOCAL lock_timeout = '1000ms'", []],
                ["SET LOCAL idle_in_transaction_session_timeout = '5000ms'", []],
                [
                    'SELECT session_user AS login, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit FROM pg_catalog.pg_roles WHERE rolname = session_user',
                    [],
                ],
                ['SET LOCAL ROLE e2ee_research_gateway', []],
                [statement, values],
            ]);
        },
    );
    it.each(['revoke_device', 'set_block', 'claim_prekey', 'send_message', 'list_messages'])(
        'refuses unsigned %s before starting SQL',
        async (name) => {
            const db = database();
            await expect(createHostedResearchRpc(db)(name as 'register_device', [user, 'device'])).rejects.toThrow(
                'unresolved',
            );
            expect(db.transaction).not.toHaveBeenCalled();
        },
    );
    it.each(
        [['not-a-uuid', 'device'], [user, 'device\n'], [user], [user, 'device', 'extra']].map((values) => [values]),
    )('refuses malformed lookup %#', async (values) => {
        const db = database();
        await expect(createHostedResearchRpc(db)('lookup_request_key', values)).rejects.toThrow('unresolved');
        expect(db.transaction).not.toHaveBeenCalled();
    });
    it.each(['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolbypassrls', 'rolinherit', 'login'])(
        'refuses unexpected login privilege %s',
        async (privilege) => {
            const db = database({ ...role, [privilege]: privilege === 'login' ? 'postgres' : true });
            await expect(createHostedResearchRpc(db)('lookup_request_key', [user, 'device'])).rejects.toThrow(
                'unresolved',
            );
            expect(db.query.mock.calls.some((call) => call[0].startsWith('SELECT e2ee_research.'))).toBe(false);
        },
    );
    it('does not report the provisional callback result when COMMIT fails', async () => {
        const db = database();
        const transaction = async <T>(body: (tx: { query: typeof db.query }) => Promise<T>): Promise<T> => {
            await body({ query: db.query });
            throw new Error('private database detail');
        };
        await expect(createHostedResearchRpc({ transaction })('lookup_request_key', [user, 'device'])).rejects.toThrow(
            'Hosted pilot request unresolved',
        );
    });
    it('remains unresolved until transaction COMMIT resolves', async () => {
        const db = database();
        let commit!: () => void;
        const committed = new Promise<void>((resolve) => {
            commit = resolve;
        });
        let resolved = false;
        const operation = createHostedResearchRpc({
            transaction: async (body) => {
                const result = await body({ query: db.query });
                await committed;
                return result;
            },
        })('lookup_request_key', [user, 'device']).then((value) => {
            resolved = true;
            return value;
        });
        await vi.waitFor(() =>
            expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('lookup_request_key'), [user, 'device']),
        );
        expect(resolved).toBe(false);
        commit();
        expect(await operation).toEqual({ accepted: true });
    });
    it.each(['https://pcisdplnodrphauixcau.supabase.co', `${PILOT_ORIGIN}/`, 'https://other.supabase.co'])(
        'refuses a different project/config alias %s',
        (url) => {
            expect(() =>
                createHostedResearchGateway({
                    supabaseUrl: url,
                    publicApiKey: 'sb_publishable_test',
                    participantUserIds: [],
                    database: database(),
                }),
            ).toThrow();
        },
    );
    it.each(
        [
            ['not-a-uuid'],
            [user, user],
            [user, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'],
        ].map((values) => [values]),
    )('refuses malformed/too-large enrollment %#', (participants) => {
        expect(() =>
            createHostedResearchGateway({
                supabaseUrl: PILOT_ORIGIN,
                publicApiKey: 'sb_publishable_test',
                participantUserIds: participants,
                database: database(),
            }),
        ).toThrow();
    });
    it.each([[], ['22222222-2222-4222-8222-222222222222']].map((values) => [values]))(
        'checks fresh Auth but denies accounts outside the explicit allowlist %#',
        async (participants) => {
            const db = database();
            const fetch = vi.fn(async () => Response.json({ id: user, user_metadata: { actor: participants[0] } }));
            const handler = createHostedResearchGateway({
                supabaseUrl: PILOT_ORIGIN,
                publicApiKey: 'sb_publishable_test',
                participantUserIds: participants,
                database: db,
                fetch,
            });
            const response = await handler(
                new Request(`${PILOT_ORIGIN}/functions/v1/scuttlebutt-e2ee-pilot/v1/register`, {
                    method: 'POST',
                    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
                    body: '{}',
                }),
            );
            expect(response.status).not.toBe(200);
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(db.transaction).not.toHaveBeenCalled();
            expect(await response.text()).not.toContain(user);
        },
    );
});
