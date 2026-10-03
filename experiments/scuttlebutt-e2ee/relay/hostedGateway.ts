/** Isolated hosted pilot. No production project, anonymous actors or unsigned SQL. */
import { createSupabaseResearchAuthenticator } from './supabaseAuth.ts';
import { createResearchSignedGateway, type ResearchSignedRpc } from './signedGateway.ts';
import { createResearchHttpGateway } from './httpGateway.ts';

export const PILOT_PROJECT_REF = 'kmtupdvwdgbhtssqqova';
export const PILOT_ORIGIN = `https://${PILOT_PROJECT_REF}.supabase.co`;
export const PILOT_BASE_PATH = '/functions/v1/scuttlebutt-e2ee-pilot';
// Observed by a JWT-protected canary on this exact hosted project (2026-10-03).
// Supabase terminates HTTPS and strips /functions/v1 before Deno.serve. This
// internal URL is NOT a native network endpoint or permission to use HTTP.
const PILOT_RUNTIME_ORIGIN = `http://${PILOT_PROJECT_REF}.supabase.co`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const fail = (): never => {
    throw new Error('Hosted pilot request unresolved');
};
const matches = (pattern: RegExp, value: unknown): value is string =>
    typeof value === 'string' && pattern.exec(value)?.[0] === value;

/** Native/server config only. URL parser exceptions can contain passwords. */
export function validatePilotDatabaseUrl(value: unknown): string {
    try {
        if (typeof value !== 'string' || value.length > 4096) return fail();
        const url = new URL(value);
        if (
            url.protocol !== 'postgresql:' ||
            url.username !== 'e2ee_pilot_edge' ||
            url.hostname !== `db.${PILOT_PROJECT_REF}.supabase.co` ||
            url.port !== '5432' ||
            url.pathname !== '/postgres' ||
            url.search ||
            url.hash ||
            !matches(/^[0-9a-f]{64}$/, url.password) ||
            url.href !== value
        )
            return fail();
        return value;
    } catch {
        return fail();
    }
}

export interface HostedResearchTransaction {
    /** Static parameterized statements only. Adapter must not log SQL arguments. */
    query(statement: string, parameters: readonly (string | number)[]): Promise<readonly Record<string, unknown>[]>;
}
export interface HostedResearchDatabase {
    /** Must resolve AFTER COMMIT, not merely after the callback returns. */
    transaction(body: (transaction: HostedResearchTransaction) => Promise<unknown>): Promise<unknown>;
}

/** Only the three signed-path entry points. Other research RPCs remain forbidden. */
export function createHostedResearchRpc(database: HostedResearchDatabase) {
    if (!database || typeof database.transaction !== 'function') return fail();
    return async (name: ResearchSignedRpc, values: readonly unknown[]): Promise<unknown> => {
        if (!Array.isArray(values) || !matches(UUID, values[0])) return fail();
        let statement: string;
        let parameters: (string | number)[];
        if (name === 'register_device') {
            if (values.length !== 2 || typeof values[1] !== 'string' || values[1].length > 4096) return fail();
            statement = 'SELECT e2ee_research.register_device($1::text,$2::text) AS result';
            parameters = [values[0], values[1]];
        } else if (name === 'lookup_request_key') {
            if (values.length !== 2 || !matches(ID, values[1])) return fail();
            statement = 'SELECT e2ee_research.lookup_request_key($1::text,$2::text) AS result';
            parameters = [values[0], values[1]];
        } else if (name === 'execute_request') {
            if (
                values.length !== 7 ||
                !matches(ID, values[1]) ||
                !matches(ID, values[2]) ||
                !['revoke', 'block', 'claim', 'send', 'list', 'policy'].includes(values[3] as string) ||
                typeof values[4] !== 'string' ||
                values[4].length > 100000 ||
                typeof values[5] !== 'number' ||
                !Number.isSafeInteger(values[5]) ||
                values[5] < 0 ||
                typeof values[6] !== 'string' ||
                values[6].length > 102400
            )
                return fail();
            statement =
                'SELECT e2ee_research.execute_request($1::text,$2::text,$3::text,$4::text,$5::text,$6::bigint,$7::text) AS result';
            parameters = [values[0], values[1], values[2], values[3] as string, values[4], values[5], values[6]];
        } else return fail();
        // Capture primitives before awaiting: no caller mutation can change an actor.
        try {
            return await database.transaction(async (transaction) => {
                await transaction.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED', []);
                await transaction.query("SET LOCAL statement_timeout = '4000ms'", []);
                await transaction.query("SET LOCAL lock_timeout = '1000ms'", []);
                await transaction.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'", []);
                const identity = await transaction.query(
                    'SELECT session_user AS login, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit FROM pg_catalog.pg_roles WHERE rolname = session_user',
                    [],
                );
                if (
                    identity.length !== 1 ||
                    identity[0].login !== 'e2ee_pilot_edge' ||
                    ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolbypassrls', 'rolinherit'].some(
                        (key) => identity[0][key] !== false,
                    )
                )
                    return fail();
                await transaction.query('SET LOCAL ROLE e2ee_research_gateway', []);
                const rows = await transaction.query(statement, parameters);
                if (rows.length !== 1 || Object.keys(rows[0]).length !== 1 || !Object.hasOwn(rows[0], 'result'))
                    return fail();
                return rows[0].result;
            });
        } catch {
            return fail();
        }
    };
}

export interface HostedResearchGatewayConfig {
    readonly supabaseUrl: string;
    readonly publicApiKey: string;
    /** Empty explicitly means closed enrollment, not allow all. Max two test accounts. */
    readonly participantUserIds: readonly string[];
    readonly database: HostedResearchDatabase;
    readonly fetch?: typeof globalThis.fetch;
}

export function createHostedResearchGateway(config: HostedResearchGatewayConfig) {
    if (
        config.supabaseUrl !== PILOT_ORIGIN ||
        !Array.isArray(config.participantUserIds) ||
        config.participantUserIds.length > 2 ||
        !config.participantUserIds.every((id) => matches(UUID, id)) ||
        new Set(config.participantUserIds).size !== config.participantUserIds.length
    )
        return fail();
    const participants = new Set(config.participantUserIds);
    const authenticate = createSupabaseResearchAuthenticator({
        supabaseUrl: PILOT_ORIGIN,
        publicApiKey: config.publicApiKey,
        fetch: config.fetch,
    });
    const gateway = createResearchSignedGateway({
        authenticate: async (credential) => {
            const principal = await authenticate(credential);
            return principal && participants.has(principal.userId) ? principal : null;
        },
        rpc: createHostedResearchRpc(config.database),
        nowSeconds: () => Math.floor(Date.now() / 1000),
    });
    return createResearchHttpGateway({ serviceOrigin: PILOT_ORIGIN, serviceBasePath: PILOT_BASE_PATH, gateway });
}

/** Only this trusted host mounting adapter remaps the two observed exact URLs. */
export function createSupabasePilotRuntimeHandler(handler: (request: Request) => Promise<Response>) {
    const endpoints = new Map(
        ['register', 'dispatch'].map((action) => [
            `${PILOT_RUNTIME_ORIGIN}/scuttlebutt-e2ee-pilot/v1/${action}`,
            `${PILOT_ORIGIN}${PILOT_BASE_PATH}/v1/${action}`,
        ]),
    );
    return async (request: Request): Promise<Response> => {
        const publicUrl = endpoints.get(request.url);
        if (!publicUrl)
            return new Response('{"version":1,"error":"request-unresolved"}', {
                status: 404,
                headers: {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                },
            });
        // No host/forwarded headers, query guessing, wildcard or prefix matching.
        // Request-as-init preserves method, headers, signal and bounded body stream.
        try {
            return await handler(new Request(publicUrl, request));
        } catch {
            return new Response('{"version":1,"error":"request-unresolved"}', {
                status: 503,
                headers: {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                },
            });
        }
    };
}
