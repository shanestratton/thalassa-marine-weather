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
    const nativeBindings: typeof researchNativePlugin = {
        configuration() {
            countFullAppNativeCall();
            return researchNativePlugin.configuration();
        },
        fenceSession(options) {
            countFullAppNativeCall();
            return researchNativePlugin.fenceSession(options);
        },
        authenticate(options) {
            countFullAppNativeCall();
            return researchNativePlugin.authenticate(options);
        },
        currentAccount() {
            countFullAppNativeCall();
            return researchNativePlugin.currentAccount();
        },
        messagePrivateAdmission(options) {
            countFullAppNativeCall();
            return researchNativePlugin.messagePrivateAdmission(options);
        },
        privateMessageIssue(options) {
            countFullAppNativeCall();
            return researchNativePlugin.privateMessageIssue(options);
        },
        privateMessageReadiness(options) {
            countFullAppNativeCall();
            return researchNativePlugin.privateMessageReadiness(options);
        },
        privateMessagePermissions(options) {
            countFullAppNativeCall();
            return researchNativePlugin.privateMessagePermissions(options);
        },
        privateMessageInbox(options) {
            countFullAppNativeCall();
            return researchNativePlugin.privateMessageInbox(options);
        },
        privateMessageThread(options) {
            countFullAppNativeCall();
            return researchNativePlugin.privateMessageThread(options);
        },
        privateMessageSendText(options) {
            countFullAppNativeCall();
            return researchNativePlugin.privateMessageSendText(options);
        },
        privateMessageRetryPending(options) {
            countFullAppNativeCall();
            return researchNativePlugin.privateMessageRetryPending(options);
        },
    };
    const native = Object.freeze(nativeBindings);
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
