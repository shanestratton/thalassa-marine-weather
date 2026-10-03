// This research deployment cannot activate app PMs or touch Thalassa production.
import postgres from 'npm:postgres@3.4.7';
import {
    createHostedResearchGateway,
    createSupabasePilotRuntimeHandler,
    PILOT_ORIGIN,
    validatePilotDatabaseUrl,
} from '../../../../relay/hostedGateway.ts';

const projectUrl = Deno.env.get('SUPABASE_URL');
const databaseUrl = Deno.env.get('E2EE_PILOT_DATABASE_URL');
const publicApiKey = Deno.env.get('SUPABASE_ANON_KEY');
const participants = Deno.env.get('E2EE_PILOT_PARTICIPANTS');
if (projectUrl !== PILOT_ORIGIN || !databaseUrl || !publicApiKey || participants === undefined) {
    throw new Error('Isolated pilot configuration unavailable');
}
function connect() {
    try {
        // No passwords/URLs are printed, even by parser/driver startup failures.
        return postgres(validatePilotDatabaseUrl(databaseUrl), {
            max: 1,
            prepare: false,
            ssl: { rejectUnauthorized: true },
            connect_timeout: 5,
            idle_timeout: 10,
            max_lifetime: 60,
            onnotice: () => undefined,
        });
    } catch {
        throw new Error('Isolated pilot configuration unavailable');
    }
}
const handler = createHostedResearchGateway({
    supabaseUrl: projectUrl,
    publicApiKey,
    participantUserIds: participants === '' ? [] : participants.split(','),
    fetch,
    database: {
        // postgres.begin resolves only after the transaction has committed. Queries
        // are sequential: no session-global role/state or pipelined pooler queries.
        transaction: async (body) => {
            // Hosted isolates do not share one pool. Close this client's connection
            // after COMMIT or rollback to respect the bounded research role's
            // connection budget; never borrow admin access or raise its limits.
            const sql = connect();
            try {
                return await sql.begin(async (transaction) => {
                    return await body({
                        query: async (statement, parameters) => {
                            return (await transaction.unsafe(statement, [...parameters])) as unknown as Record<
                                string,
                                unknown
                            >[];
                        },
                    });
                });
            } catch (error) {
                // Never print exception.message, query text, arguments, DSN or stack.
                const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
                const safeCodes = [
                    'ENOTFOUND',
                    'ECONNREFUSED',
                    'ETIMEDOUT',
                    'CONNECT_TIMEOUT',
                    'DEPTH_ZERO_SELF_SIGNED_CERT',
                    'SELF_SIGNED_CERT_IN_CHAIN',
                    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
                    '28000',
                    '28P01',
                    '42501',
                    'P0001',
                    '57014',
                    '53300',
                ];
                console.info(`pilot-db-refused:${safeCodes.includes(String(code)) ? code : 'unclassified'}`);
                throw new Error('Isolated pilot request unresolved');
            } finally {
                await sql.end({ timeout: 1 });
            }
        },
    },
});
Deno.serve(createSupabasePilotRuntimeHandler(handler));
