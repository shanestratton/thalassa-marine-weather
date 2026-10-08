/** One Research SDK factory, not another Auth loop. The full-App backend alias
 * cannot access this private, URL-pinned browser transport capability. */
import { Capacitor } from '@capacitor/core';
import { createClient } from '@supabase/supabase-js';
import { researchNativePlugin, type ResearchAuthDependencies } from '../bridge-web/auth';
import { createPrivateMessageResearchRuntime } from '../app-pilot/runtime';
import { configureFullAppPlatform } from './core';

export function createFullAppRuntimeFactory(researchAuthFetch: typeof fetch) {
    const platform = Capacitor.getPlatform();
    configureFullAppPlatform(platform === 'ios' ? 'ios' : 'web');
    const auth: ResearchAuthDependencies = {
        native: researchNativePlugin,
        supported: () =>
            Capacitor.isNativePlatform() &&
            Capacitor.getPlatform() === 'ios' &&
            Capacitor.isPluginAvailable('ScuttlebuttResearchAuth'),
        createSdk(configuration, options) {
            const client = createClient(configuration.supabaseUrl, configuration.publicApiKey, {
                ...options,
                global: { fetch: researchAuthFetch },
            });
            return {
                getSession: () => client.auth.getSession(),
                signInWithPassword: (credentials) => client.auth.signInWithPassword(credentials),
                signOut: (scope) => client.auth.signOut(scope),
                onAuthStateChange: (callback) => client.auth.onAuthStateChange(callback),
                stopAutoRefresh: () => client.auth.stopAutoRefresh(),
            };
        },
    };
    return () => createPrivateMessageResearchRuntime({ auth, native: researchNativePlugin });
}
