/**
 * End a user's Supabase Auth sessions from the server, for Apple's
 * consent-revoked event.
 *
 * Supabase Auth has no admin "sign this user out" by user id. Its admin routes
 * cover users, factors, passkeys, generate_link, SSO and OAuth clients, and
 * POST /logout needs the user's own access token (supabase/auth
 * internal/api/api.go, read 2026-10-08). Its own global logout is a single
 * `DELETE FROM sessions WHERE user_id = ?` (internal/models/sessions.go,
 * Logout); the session's refresh tokens and MFA claims cascade from that row.
 * This does the same over the Edge runtime's default SUPABASE_DB_URL, narrowed
 * to sessions started at or before Apple's event so a later sign-in (by email,
 * say) survives. Each signed-out device's next token refresh then fails and
 * supabase-js clears its local session.
 *
 * Nothing here is logged: the caller logs only the SQLSTATE this throws.
 */
import postgres from 'npm:postgres@3';

export async function endUserSessionsStartedBy(
    databaseUrl: string,
    userId: string,
    startedAtOrBefore: Date,
): Promise<number> {
    const sql = postgres(databaseUrl, {
        // Unnamed statements work through Supavisor's transaction pooler too.
        prepare: false,
        max: 1,
        connect_timeout: 10,
        idle_timeout: 5,
        onnotice: () => undefined,
    });
    try {
        const ended = await sql`
            DELETE FROM auth.sessions
            WHERE user_id = ${userId}::uuid
              AND (created_at IS NULL OR created_at <= ${startedAtOrBefore.toISOString()}::timestamptz)
            RETURNING id
        `;
        return ended.length;
    } catch (error) {
        // Driver errors can carry the statement's parameters; keep only the SQLSTATE.
        const code = (error as { code?: unknown } | null)?.code;
        const sqlState = typeof code === 'string' ? code.replace(/[^A-Za-z0-9_]/g, '').slice(0, 32) : '';
        throw new Error(`session sign-out failed (${sqlState || 'database_error'})`);
    } finally {
        await sql.end({ timeout: 5 }).catch(() => undefined);
    }
}
