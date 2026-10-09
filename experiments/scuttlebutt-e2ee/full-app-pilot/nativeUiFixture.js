/** Simulator-only atDocumentStart script for the explicit version-3
 * full-app-native-startup resource and version-2 bound native report validator.
 * The existing controller/SDK performs Auth. The fixed response below is a
 * declared synthetic service response, never an App Auth-store/User assignment.
 * Native verification must retain the existing catch-all URLProtocol semantics.
 */
(() => {
    const runID = '__RESEARCH_FULL_APP_NATIVE_RUN_ID__';
    const nonce = '__RESEARCH_FULL_APP_NATIVE_NONCE__';
    const scenario = 'full-app-native-startup';
    const origin = 'https://kmtupdvwdgbhtssqqova.supabase.co';
    const owner = '93000000-0000-4000-8000-000000000001';
    const email = 'e2ee-local-ui-fixture@thalassa.invalid';
    const password = 'LocalOnlyResearchFixture-2026';
    const bearer = 'research-local-ui-fixture-bearer';
    const publicApiKey = 'sb_publishable_research_local_ui_fixture';
    const evidenceName = '__THALASSA_FULL_APP_WINDOW_EVIDENCE__';
    const remountName = '__THALASSA_FULL_APP_WINDOW_REMOUNT__';
    const fenceNames = [
        'fetch',
        'xhr',
        'webSocket',
        'eventSource',
        'beacon',
        'preservedFetch',
        'preservedXhr',
        'worker',
        'sharedWorker',
        'serviceWorker',
        'caches',
        'indexedDB',
        'geolocation',
        'media',
        'clipboard',
        'audio',
        'navigation',
        'permissions',
        'otherNetwork',
        'localStorageReads',
        'localStorageWrites',
        'sessionStorageReads',
        'sessionStorageWrites',
        'storageRefused',
        'storageManager',
        'patchFailures',
        'locationPatchUnavailable',
        'authRequests',
        'authResponses',
        'authRefused',
    ];
    const boundaryNames = [
        'instrumentRequests',
        'gpsRequests',
        'internetRequests',
        'aisRequests',
        'appleRequests',
        'anchorRequests',
        'anchorSyncRequests',
        'anchorPiRequests',
        'shiplogRequests',
        'vesselRequests',
        'piRequests',
        'nativeRequests',
        'observations',
        'subscriptions',
        'cleanups',
    ];
    const memoryNames = [
        'preferenceReads',
        'preferenceWrites',
        'preferenceRemovals',
        'preferenceClears',
        'preferenceKeys',
        'cacheReads',
        'cacheWrites',
        'cacheRemovals',
        'cacheFlushes',
        'versionReads',
        'versionWrites',
        'refusals',
    ];
    const phases = [
        'script-installed',
        'dom-ready',
        'http-refusals',
        'cold-ready',
        'signed-in',
        'admission-returned',
        'terminal-closed',
        'root-remounted',
        'fixture-complete',
        'fixture-failed',
    ];
    const cases = [];
    const sdkCounts = { password: 0, unexpected: 0 };
    const until = Date.now() + 100000;
    let assertions = 0,
        reported = false,
        lastEvidence = null;
    const refuse = () => {
        throw new Error('Full App native fixture refused');
    };
    const require = (value) => {
        if (!value) refuse();
        assertions = Math.min(10000, assertions + 1);
    };
    const own = (row, key) => Object.getOwnPropertyDescriptor(row, key)?.value;
    function exact(row, names) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) refuse();
        const keys = Reflect.ownKeys(row);
        if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key)))
            refuse();
        const result = {};
        for (const name of names) {
            const descriptor = Object.getOwnPropertyDescriptor(row, name);
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) refuse();
            result[name] = descriptor.value;
        }
        return result;
    }
    function count(value, max = 10000) {
        if (!Number.isSafeInteger(value) || value < 0 || value > max) refuse();
        return value;
    }
    function copyCounts(row, names, limit) {
        const copied = exact(row, names);
        for (const key of names) copied[key] = count(copied[key], limit);
        return Object.freeze(copied);
    }
    function nullableBoolean(value) {
        if (value !== null && typeof value !== 'boolean') refuse();
        return value;
    }
    function safeEvidence() {
        const descriptor = Object.getOwnPropertyDescriptor(window, evidenceName);
        if (!descriptor) return null;
        if (descriptor.configurable || descriptor.set || typeof descriptor.get !== 'function') refuse();
        const row = exact(window[evidenceName], [
            'version',
            'runId',
            'phase',
            'fence',
            'sdk',
            'root',
            'auth',
            'authScope',
            'privateSelection',
            'legacyPermitAvailable',
            'core',
            'boundaries',
            'memory',
            'lifecycle',
        ]);
        if (row.version !== 1 || row.runId !== runID || !['starting', 'ready', 'failed'].includes(row.phase)) refuse();
        let fence = null,
            core = null;
        if (row.fence !== null) {
            const data = exact(row.fence, ['version', 'status', 'counts']);
            if (data.version !== 1 || !['uninstalled', 'installed', 'failed'].includes(data.status)) refuse();
            fence = Object.freeze({
                version: 1,
                status: data.status,
                counts: copyCounts(data.counts, fenceNames, 10000),
            });
        }
        if (row.core !== null) {
            const data = exact(row.core, ['registrationAttempts', 'methodAttempts', 'platform']);
            if (!['web', 'ios'].includes(data.platform)) refuse();
            core = Object.freeze({
                registrationAttempts: count(data.registrationAttempts, 1024),
                methodAttempts: count(data.methodAttempts, 1024),
                platform: data.platform,
            });
        }
        const auth = exact(row.auth, ['status', 'userPresent', 'authChecked']);
        if (
            ![
                'unknown',
                'unsupported',
                'unavailable',
                'signed_out',
                'verifying',
                'authenticated',
                'detached',
                'inactive',
            ].includes(auth.status)
        )
            refuse();
        auth.userPresent = nullableBoolean(auth.userPresent);
        auth.authChecked = nullableBoolean(auth.authChecked);
        const scope = exact(row.authScope, [
            'originalUserPresent',
            'originalAnonymous',
            'originalGeneration',
            'currentUserPresent',
            'currentAnonymous',
            'currentGeneration',
        ]);
        for (const key of ['originalUserPresent', 'originalAnonymous', 'currentUserPresent', 'currentAnonymous'])
            scope[key] = nullableBoolean(scope[key]);
        for (const key of ['originalGeneration', 'currentGeneration'])
            if (scope[key] !== null) scope[key] = count(scope[key]);
        const lifecycle = exact(row.lifecycle, ['stopped']);
        if (
            typeof lifecycle.stopped !== 'boolean' ||
            (row.privateSelection !== null && !['native-unavailable', 'native-pilot'].includes(row.privateSelection))
        )
            refuse();
        const result = Object.freeze({
            version: 1,
            runId: runID,
            phase: row.phase,
            fence,
            sdk: copyCounts(row.sdk, ['runtimeCreations', 'sdkConstructions', 'nativeCalls'], 10000),
            root: copyCounts(row.root, ['mounts', 'remounts', 'closedRenders'], 10000),
            auth: Object.freeze(auth),
            authScope: Object.freeze(scope),
            privateSelection: row.privateSelection,
            legacyPermitAvailable: nullableBoolean(row.legacyPermitAvailable),
            core,
            boundaries: row.boundaries === null ? null : copyCounts(row.boundaries, boundaryNames, 1024),
            memory: row.memory === null ? null : copyCounts(row.memory, memoryNames, 1024),
            lifecycle: Object.freeze(lifecycle),
        });
        lastEvidence = result;
        return result;
    }
    const button = (label) =>
        [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
    const enabled = (node) => node instanceof HTMLButtonElement && !node.disabled;
    function domFacts() {
        const body = document.body?.textContent ?? '';
        return {
            actualAppNavigation: !!document.querySelector('nav[aria-label="Main"]'),
            authenticatedNotice: body.includes('Account: authenticated'),
            signedOutNotice: body.includes('Account: signed_out'),
            unknownAdmission: body.includes('Local private admission: unknown'),
            unavailablePrivateView: body.includes('The native private message test is unavailable'),
            stoppedNotice: body.includes('Research window stopped.'),
            messageLogAbsent: !document.querySelector('[role="log"]'),
            signInEnabled: enabled(button('Sign in and verify')),
            privateOpenEnabled: enabled(button('Check native setup and open messages')),
            passwordEmpty: document.getElementById('pilot-password')?.value === '',
        };
    }
    function post(status, phase) {
        if (reported || !phases.includes(phase)) return;
        if (status !== 'progress') reported = true;
        try {
            window.webkit.messageHandlers.researchLocalUiFixture.postMessage({
                version: 2,
                runID,
                nonce,
                scenario,
                status,
                phase,
                assertions,
                sdkCounts: { ...sdkCounts },
                cases: status === 'failed' ? ['fixture-failed'] : [...cases],
                windowEvidence: lastEvidence,
                domFacts: domFacts(),
                syntheticPagehide: true,
                realOsLifecycleOrBfCacheProved: false,
            });
        } catch {
            /* Missing native receipt is a timeout/failure, never a local pass or live fallback. */
        }
    }
    async function wait(predicate) {
        const deadline = Math.min(until, Date.now() + 20000);
        while (Date.now() < deadline) {
            if (sdkCounts.unexpected !== 0) refuse();
            const observed = safeEvidence();
            if (observed?.phase === 'failed' || observed?.fence?.status === 'failed') refuse();
            if (predicate(observed, domFacts())) return observed;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        refuse();
    }
    function common(observed, mounts, remounts, sdkConstructions, authRequests) {
        require(observed?.phase === 'ready' && observed.fence?.status === 'installed');
        require(observed.fence.counts.patchFailures === 0 && observed.core?.platform === 'ios');
        require(observed.boundaries !== null && observed.memory !== null);
        require(observed.auth.userPresent === false && observed.auth.authChecked === true);
        require(observed.privateSelection === 'native-unavailable' && observed.legacyPermitAvailable === false);
        require(observed.sdk.runtimeCreations === mounts && observed.sdk.sdkConstructions === sdkConstructions);
        require(
            observed.root.mounts === mounts &&
                observed.root.remounts === remounts &&
                observed.root.closedRenders >= mounts,
        );
        require(observed.authScope.originalUserPresent === false && observed.authScope.originalAnonymous === true);
        require(observed.authScope.originalGeneration !== null && observed.authScope.currentGeneration !== null);
        require(observed.sdk.nativeCalls > 0); // Dispatch counts only; NOT native completion or permission.
        require(
            observed.fence.counts.authRequests === authRequests &&
                observed.fence.counts.authResponses === authRequests &&
                observed.fence.counts.authRefused === 0 &&
                sdkCounts.password === authRequests &&
                sdkCounts.unexpected === 0,
        );
        for (const name of [
            'fetch',
            'xhr',
            'webSocket',
            'eventSource',
            'beacon',
            'preservedFetch',
            'preservedXhr',
            'worker',
            'sharedWorker',
            'serviceWorker',
            'otherNetwork',
        ])
            require(observed.fence.counts[name] === 0);
    }
    const setInput = (input, value) => {
        require(input instanceof HTMLInputElement);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        require(typeof setter === 'function');
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const unexpected = () => {
        sdkCounts.unexpected = Math.min(10000, sdkCounts.unexpected + 1);
        refuse();
    };
    async function challengeHttpFence() {
        require(typeof window.Capacitor?.nativePromise === 'function');
        for (const route of ['CapacitorHttp', 'CAPHttpPlugin']) {
            for (const method of ['request', 'get', 'post', 'put', 'patch', 'delete']) {
                let refused = false;
                try {
                    await window.Capacitor.nativePromise(route, method, {
                        url: 'capacitor://localhost/__research_full_app_native_http_probe__',
                    });
                } catch (error) {
                    // Never publish errors/options; the fixed native code only identifies
                    // this deliberate refusal, not successful HTTP or an OS-wide sandbox.
                    refused = own(error, 'code') === 'FULL_APP_RESEARCH_HTTP_REFUSED';
                }
                require(refused);
            }
        }
        cases.push('native-http-refusals');
        post('progress', 'http-refusals');
    }
    async function boundedBody(request) {
        if (!request.body || typeof request.body.getReader !== 'function') refuse();
        const reader = request.body.getReader(),
            parts = [];
        let bytes = 0;
        try {
            for (;;) {
                const result = await reader.read();
                if (result.done) break;
                if (!(result.value instanceof Uint8Array)) refuse();
                bytes += result.value.byteLength;
                if (bytes > 4096) refuse();
                parts.push(result.value);
            }
        } catch {
            try {
                await reader.cancel();
            } catch {
                /* no body/error publication */
            }
            refuse();
        } finally {
            reader.releaseLock();
        }
        const body = new Uint8Array(bytes);
        let cursor = 0;
        for (const part of parts) {
            body.set(part, cursor);
            cursor += part.byteLength;
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
    }
    try {
        require(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(runID)?.[0] === runID);
        require(/^[0-9a-f]{64}$/.exec(nonce)?.[0] === nonce);
        require(window === window.top && location.protocol === 'capacitor:' && location.hostname === 'localhost');
        require(document.readyState === 'loading' && !Object.getOwnPropertyDescriptor(window, evidenceName));
        const url = new URL(location.href);
        require(url.search === '' && url.hash === '');
        url.searchParams.set('fullAppWindowProofRun', runID);
        url.searchParams.set('fullAppWindowProofNonce', nonce);
        history.replaceState(null, '', url.href); // Same document: no navigation or second entry load.
        require(
            new URL(location.href).searchParams.get('fullAppWindowProofRun') === runID &&
                new URL(location.href).searchParams.get('fullAppWindowProofNonce') === nonce,
        );
        const RequestType = Request,
            ResponseType = Response;
        const syntheticFetch = async (input, init) => {
            let request, text, body;
            try {
                request = new RequestType(input, init);
                if (
                    reported ||
                    sdkCounts.password !== 0 ||
                    request.url !== origin + '/auth/v1/token?grant_type=password' ||
                    request.method !== 'POST' ||
                    request.redirect !== 'error' ||
                    request.credentials !== 'omit' ||
                    request.cache !== 'no-store' ||
                    request.mode !== 'cors' ||
                    request.headers.get('apikey') !== publicApiKey
                )
                    refuse();
                const authorization = request.headers.get('authorization');
                if (authorization !== null && authorization !== 'Bearer ' + publicApiKey) refuse();
                text = await boundedBody(request);
                body = JSON.parse(text);
                if (
                    !body ||
                    typeof body !== 'object' ||
                    Array.isArray(body) ||
                    body.email !== email ||
                    body.password !== password ||
                    Object.keys(body).some((key) => !['email', 'password', 'gotrue_meta_security'].includes(key)) ||
                    (body.gotrue_meta_security !== undefined &&
                        (!body.gotrue_meta_security ||
                            typeof body.gotrue_meta_security !== 'object' ||
                            Array.isArray(body.gotrue_meta_security) ||
                            Object.keys(body.gotrue_meta_security).length !== 0))
                )
                    refuse();
            } catch {
                return unexpected();
            }
            sdkCounts.password += 1;
            // Synthetic service envelope consumed by the REAL SDK; the App User stays null.
            return new ResponseType(
                JSON.stringify({
                    access_token: bearer,
                    token_type: 'bearer',
                    expires_in: 3600,
                    expires_at: Math.floor(Date.now() / 1000) + 3600,
                    refresh_token: 'research-local-ui-fixture-refresh',
                    user: {
                        id: owner,
                        email,
                        aud: 'authenticated',
                        role: 'authenticated',
                        app_metadata: {},
                        user_metadata: {},
                        created_at: '2026-10-09T00:00:00Z',
                    },
                }),
                {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                        'cache-control': 'no-store',
                    },
                },
            );
        };
        // Same ONE synthetic transport for both aliases. Nothing is sealed here:
        // the real entry must capture it privately and install the full fence.
        Object.defineProperties(window, {
            fetch: {
                value: syntheticFetch,
                configurable: true,
                writable: true,
                enumerable: true,
            },
            CapacitorWebFetch: {
                value: syntheticFetch,
                configurable: true,
                writable: true,
                enumerable: true,
            },
        });
        require(own(window, 'fetch') === syntheticFetch && own(window, 'CapacitorWebFetch') === syntheticFetch);
        post('progress', 'script-installed');
        document.addEventListener(
            'DOMContentLoaded',
            () => {
                post('progress', 'dom-ready');
                void (async () => {
                    await challengeHttpFence();
                    let observed = await wait(
                        (value, facts) =>
                            value?.phase === 'ready' &&
                            value.auth.status === 'signed_out' &&
                            facts.actualAppNavigation &&
                            facts.signInEnabled &&
                            !facts.privateOpenEnabled,
                    );
                    common(observed, 1, 0, 1, 0);
                    require(
                        observed.authScope.currentUserPresent === false && observed.authScope.currentAnonymous === true,
                    );
                    window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'chat' } }));
                    await wait((_value, facts) => facts.unavailablePrivateView && facts.messageLogAbsent);
                    cases.push('cold-root-closed');
                    post('progress', 'cold-ready');
                    setInput(document.getElementById('pilot-email'), email);
                    setInput(document.getElementById('pilot-password'), password);
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    const secret = document.getElementById('pilot-password');
                    require(secret instanceof HTMLInputElement && secret.form instanceof window.HTMLFormElement);
                    secret.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                    observed = await wait(
                        (value, facts) =>
                            value?.auth.status === 'authenticated' &&
                            facts.authenticatedNotice &&
                            facts.privateOpenEnabled &&
                            facts.passwordEmpty,
                    );
                    common(observed, 1, 0, 1, 1);
                    require(
                        observed.authScope.currentUserPresent === true && observed.authScope.currentAnonymous === false,
                    );
                    cases.push('sdk-native-auth-browse-only');
                    post('progress', 'signed-in');
                    button('Check native setup and open messages').click();
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    observed = await wait(
                        (value, facts) =>
                            value?.auth.status === 'authenticated' &&
                            facts.unknownAdmission &&
                            facts.privateOpenEnabled &&
                            facts.unavailablePrivateView &&
                            facts.messageLogAbsent &&
                            facts.passwordEmpty,
                    );
                    common(observed, 1, 0, 1, 1);
                    cases.push('unknown-admission-no-private-open');
                    post('progress', 'admission-returned');
                    window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false }));
                    observed = await wait(
                        (value, facts) =>
                            value?.lifecycle.stopped === true &&
                            value.auth.status === 'inactive' &&
                            facts.stoppedNotice &&
                            !facts.privateOpenEnabled &&
                            facts.unavailablePrivateView &&
                            facts.messageLogAbsent,
                    );
                    common(observed, 1, 0, 1, 1);
                    cases.push('synthetic-terminal-pagehide');
                    post('progress', 'terminal-closed');
                    const control = Object.getOwnPropertyDescriptor(window, remountName);
                    require(
                        control && !control.configurable && !control.writable && typeof control.value === 'function',
                    );
                    require(control.value({ runId: runID, nonce }) === true);
                    observed = await wait(
                        (value, facts) =>
                            value?.auth.status === 'signed_out' &&
                            value.root.mounts === 2 &&
                            value.root.remounts === 1 &&
                            value.lifecycle.stopped === false &&
                            facts.signedOutNotice &&
                            facts.signInEnabled &&
                            !facts.privateOpenEnabled &&
                            !facts.stoppedNotice &&
                            facts.unavailablePrivateView &&
                            facts.messageLogAbsent,
                    );
                    common(observed, 2, 1, 2, 1);
                    require(
                        observed.authScope.currentUserPresent === false && observed.authScope.currentAnonymous === true,
                    );
                    require(control.value({ runId: runID, nonce }) === false);
                    cases.push('fresh-root-no-restored-authority');
                    post('progress', 'root-remounted');
                    window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false }));
                    observed = await wait(
                        (value, facts) =>
                            value?.lifecycle.stopped === true &&
                            value.auth.status === 'inactive' &&
                            facts.stoppedNotice &&
                            !facts.privateOpenEnabled &&
                            facts.unavailablePrivateView &&
                            facts.messageLogAbsent,
                    );
                    common(observed, 2, 1, 2, 1);
                    cases.push('final-root-closed');
                    post('passed', 'fixture-complete'); // DOM/JS pass ONLY; native host must independently refuse/verify final evidence.
                })().catch(() => {
                    // Only the existing controller's lifecycle path is used to close.
                    // No fixture sign-out, enrollment, account or key reset is created.
                    try {
                        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: false }));
                    } catch {
                        /* fixed failure still reported; no fallback */
                    }
                    post('failed', 'fixture-failed');
                });
            },
            { once: true },
        );
    } catch {
        post('failed', 'fixture-failed');
    }
})();
