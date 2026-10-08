/** Trusted WKUserScript for a fresh, compile-flagged simulator ONLY.
 * Real SupabaseJS/React/Capacitor are exercised with synthetic Auth responses.
 * Never invokes original network, setup, mutation or message operations.
 */
(() => {
    const fixtureRunID = '__RESEARCH_LOCAL_UI_RUN_ID__';
    const origin = 'https://kmtupdvwdgbhtssqqova.supabase.co';
    const owner = '93000000-0000-4000-8000-000000000001';
    const email = 'e2ee-local-ui-fixture@thalassa.invalid';
    const password = 'LocalOnlyResearchFixture-2026';
    const token = 'research-local-ui-fixture-bearer';
    const counts = { password: 0, unexpected: 0 };
    const cases = [];
    let assertions = 0,
        reported = false;
    const progress = (phase) =>
        window.webkit.messageHandlers.researchLocalUiFixture.postMessage({
            version: 1,
            runID: fixtureRunID,
            status: 'progress',
            phase,
        });
    const require = (value) => {
        if (!value) throw new Error('Local UI fixture assertion');
        assertions += 1;
    };
    const denied = () => {
        counts.unexpected += 1;
        throw new Error('Local UI fixture network refused');
    };
    const report = (status) => {
        if (reported) return;
        reported = true;
        // The native host replaces only this fixed marker with its owned run ID.
        window.webkit.messageHandlers.researchLocalUiFixture.postMessage({
            version: 1,
            runID: fixtureRunID,
            status,
            assertions,
            sdkCounts: { ...counts },
            cases: status === 'passed' ? cases : ['fixture-failed'],
        });
    };
    const wait = async (predicate) => {
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            if (predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Local UI fixture deadline');
    };
    const button = (label) =>
        [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
    try {
        progress('script-installed');
        Object.defineProperty(window, 'fetch', {
            configurable: false,
            writable: false,
            value: async (input, init) => {
                let request;
                try {
                    request = new Request(input, init);
                } catch {
                    return denied();
                }
                if (request.url !== origin + '/auth/v1/token?grant_type=password' || request.method !== 'POST')
                    return denied();
                let body;
                try {
                    body = await request.json();
                } catch {
                    return denied();
                }
                if (
                    !body ||
                    body.email !== email ||
                    body.password !== password ||
                    Object.keys(body).some((key) => !['email', 'password', 'gotrue_meta_security'].includes(key)) ||
                    (body.gotrue_meta_security && Object.keys(body.gotrue_meta_security).length !== 0)
                )
                    return denied();
                counts.password += 1;
                return new Response(
                    JSON.stringify({
                        access_token: token,
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
                            created_at: '2026-10-08T00:00:00Z',
                        },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
                );
            },
        });
        Object.defineProperty(window, 'XMLHttpRequest', {
            configurable: false,
            writable: false,
            value: class {
                constructor() {
                    denied();
                }
            },
        });
        Object.defineProperty(window, 'WebSocket', {
            configurable: false,
            writable: false,
            value: class {
                constructor() {
                    denied();
                }
            },
        });
        Object.defineProperty(navigator, 'sendBeacon', { configurable: false, writable: false, value: denied });
        window.addEventListener(
            'DOMContentLoaded',
            () => {
                progress('dom-ready');
                void (async () => {
                    await wait(() => button('Sign in and verify') && !button('Sign in and verify').disabled);
                    require(document.body.textContent.includes('Sending is blocked.'));
                    require(counts.password === 0);
                    cases.push('cold-denied');
                    progress('cold-ready');
                    const mail = document.getElementById('pilot-email'),
                        secret = document.getElementById('pilot-password');
                    require(mail instanceof HTMLInputElement && secret instanceof HTMLInputElement);
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    setter.call(mail, email);
                    mail.dispatchEvent(new Event('input', { bubbles: true }));
                    setter.call(secret, password);
                    secret.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    secret.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                    await wait(
                        () =>
                            document.body.textContent.includes('Account: authenticated') &&
                            button('Check native setup and open messages') &&
                            !button('Check native setup and open messages').disabled,
                    );
                    require(counts.password === 1);
                    require(secret.value === '');
                    cases.push('sign-in');
                    progress('signed-in');
                    button('Check native setup and open messages').click();
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    await wait(
                        () =>
                            document.body.textContent.includes('Local private admission: unknown') &&
                            !button('Check native setup and open messages').disabled,
                    );
                    require(document.body.textContent.includes('Account: authenticated'));
                    cases.push('unknown-admission');
                    progress('admission-returned');
                    require(document.body.textContent.includes('Sending is blocked.'));
                    require(!document.querySelector('[role="log"]') && !document.querySelector('[role="listitem"]'));
                    cases.push('no-private-open');
                    require(secret.value === '');
                    cases.push('password-cleared');
                    require(counts.unexpected === 0);
                    report('passed');
                })().catch(() => report('failed'));
            },
            { once: true },
        );
    } catch {
        report('failed');
    }
})();
