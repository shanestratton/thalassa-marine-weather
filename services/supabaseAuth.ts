import { supabase, supabaseAnonKey } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';

/** Headers for user-billed Edge Functions. Public anon credentials are never treated as user auth. */
export async function getAuthenticatedFunctionHeaders(): Promise<Record<string, string>> {
    if (!supabase || !supabaseAnonKey) throw new Error('Supabase is not configured');
    const scope = getAuthIdentityScope();
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) {
        throw new Error('Sign in to use this online service');
    }
    const { data, error } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (error || !accessToken || data.session?.user?.id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) {
        throw new Error('Sign in to use this online service');
    }
    return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: supabaseAnonKey,
    };
}
