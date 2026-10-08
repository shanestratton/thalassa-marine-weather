/** One Research SDK factory, not another Auth loop. The full-App backend alias
 * cannot access this private, URL-pinned browser transport capability. */
import { Capacitor } from '@capacitor/core';
import { createClient } from '@supabase/supabase-js';
import { researchNativePlugin, type ResearchAuthDependencies } from '../bridge-web/auth';
import { createPrivateMessageResearchRuntime } from '../app-pilot/runtime';
import { configureFullAppPlatform } from './core';
import { countFullAppNativeCall, countFullAppRuntimeCreation, countFullAppSdkConstruction } from './windowEvidence';

export function createFullAppRuntimeFactory(researchAuthFetch: typeof fetch) {
    const platform = Capacitor.getPlatform();
    configureFullAppPlatform(platform === 'ios' ? 'ios' : 'web');
    // One fixed wrapper identity for this factory and all of its remounts. The
    // controller's native-fence FIFO remains keyed to that same identity.
    // Count calls only; arguments/results never enter diagnostic state.
    const native = Object.freeze(
        Object.fromEntries(
            [
                'configuration',
                'fenceSession',
                'authenticate',
                'currentAccount',
                'messagePrivateAdmission',
                'privateMessageIssue',
                'privateMessageReadiness',
                'privateMessagePermissions',
                'privateMessageInbox',
                'privateMessageThread',
                'privateMessageSendText',
                'privateMessageRetryPending',
            ].map((name) => [
                name,
                (...args: unknown[]) => {
                    countFullAppNativeCall();
                    const method = Reflect.get(researchNativePlugin, name) as (...values: unknown[]) => unknown;
                    return method.apply(researchNativePlugin, args);
                },
            ]),
        ),
    ) as typeof researchNativePlugin;
    const auth: ResearchAuthDependencies = {
        native,
        supported: () =>
            Capacitor.isNativePlatform() &&
            Capacitor.getPlatform() === 'ios' &&
            Capacitor.isPluginAvailable('ScuttlebuttResearchAuth'),
        createSdk(configuration, options) {
            const client = createClient(configuration.supabaseUrl, configuration.publicApiKey, {
                ...options,
                global: { fetch: researchAuthFetch },
            });
            countFullAppSdkConstruction();
            return {
                getSession: () => client.auth.getSession(),
                signInWithPassword: (credentials) => client.auth.signInWithPassword(credentials),
                signOut: (scope) => client.auth.signOut(scope),
                onAuthStateChange: (callback) => client.auth.onAuthStateChange(callback),
                stopAutoRefresh: () => client.auth.stopAutoRefresh(),
            };
        },
    };
    return () => {
        const runtime = createPrivateMessageResearchRuntime({ auth, native });
        countFullAppRuntimeCreation();
        return runtime;
    };
}
