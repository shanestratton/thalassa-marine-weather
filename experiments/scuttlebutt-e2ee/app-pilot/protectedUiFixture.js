/** Trusted simulator-only DOM driver. Real SDK/React/Capacitor/native provider;
 * synthetic Auth and native in-memory relay. No live connection or PM API
 * shortcut: setup/peer actions are explicit, separate native fixture controls.
 */
(() => {
    const runID = '__RESEARCH_LOCAL_UI_RUN_ID__';
    const origin = 'https://kmtupdvwdgbhtssqqova.supabase.co';
    const owner = '93000000-0000-4000-8000-000000000001';
    const email = 'e2ee-local-ui-fixture@thalassa.invalid';
    const password = 'LocalOnlyResearchFixture-2026';
    const token = 'research-local-ui-fixture-bearer';
    const outgoing = 'Protected UI outgoing canary',
        incoming = 'Protected UI peer canary',
        opener = 'Protected UI opener canary';
    const counts = { password: 0, unexpected: 0 },
        cases = [];
    let assertions = 0,
        completed = false,
        prepared = false,
        peerReplied = false,
        hostInitiates,
        failed = false;
    const native = (value) =>
        window.webkit.messageHandlers.researchLocalUiFixture.postMessage({ version: 1, runID, ...value });
    const progress = (phase) => native({ status: 'progress', phase });
    const control = (phase) => native({ status: 'control', phase });
    const require = (value) => {
        if (!value) throw new Error('Protected UI fixture assertion');
        assertions += 1;
    };
    const denied = () => {
        counts.unexpected += 1;
        throw new Error('Protected UI fixture network refused');
    };
    const report = (status) => {
        if (completed) return;
        completed = true;
        native({
            status,
            assertions,
            sdkCounts: { ...counts },
            cases: status === 'passed' ? cases : ['fixture-failed'],
            domFacts: {
                logPresent: !!document.querySelector('[role="log"]'),
                outgoingCount: rows(outgoing).length,
                outgoingAccepted: rows(outgoing).some((node) => statusOf(node).includes('Relay accepted')),
                composeEmpty: document.querySelector('input[aria-label="Message Paired sailor"]')?.value === '',
                unavailableNotice:
                    document.body.textContent.includes('The encryption test is unavailable') ||
                    document.body.textContent.includes('native private message test is unavailable'),
                closedNotice: document.body.textContent.includes('Private message view closed'),
            },
        });
    };
    const wait = async (predicate) => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (failed) throw new Error('Protected UI native fixture refused');
            if (predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Protected UI fixture deadline');
    };
    const button = (label) =>
        [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === label);
    const enabled = (node) => node instanceof HTMLButtonElement && !node.disabled;
    const rows = (text) => [...document.querySelectorAll('[role="log"] p')].filter((node) => node.textContent === text);
    const statusOf = (node) => node.parentElement.textContent;
    const setInput = (input, value) => {
        require(input instanceof HTMLInputElement);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    try {
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
        window.addEventListener('research-protected-ui-step', (event) => {
            const detail = event.detail;
            if (!detail || typeof detail !== 'object') {
                failed = true;
                return;
            }
            if (
                detail.phase === 'prepared' &&
                Object.keys(detail).sort().join(',') === 'hostInitiates,phase' &&
                typeof detail.hostInitiates === 'boolean' &&
                !prepared
            ) {
                hostInitiates = detail.hostInitiates;
                prepared = true;
            } else if (
                detail.phase === 'peer-replied' &&
                Object.keys(detail).join(',') === 'phase' &&
                prepared &&
                !peerReplied
            )
                peerReplied = true;
            else failed = true;
        });
        progress('script-installed');
        window.addEventListener(
            'DOMContentLoaded',
            () => {
                progress('dom-ready');
                void (async () => {
                    await wait(() => enabled(button('Sign in and verify')));
                    require(document.body.textContent.includes('Sending is blocked.'));
                    require(counts.password === 0 && !document.querySelector('[role="log"]'));
                    cases.push('cold-denied');
                    setInput(document.getElementById('pilot-email'), email);
                    const secret = document.getElementById('pilot-password');
                    setInput(secret, password);
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    secret.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                    await wait(
                        () =>
                            document.body.textContent.includes('Account: authenticated') &&
                            enabled(button('Check native setup and open messages')),
                    );
                    require(counts.password === 1 && secret.value === '');
                    cases.push('sign-in');
                    progress('signed-in');
                    require(document.body.textContent.includes('Sending is blocked.'));
                    control('protected-setup');
                    await wait(() => prepared);
                    require(typeof hostInitiates === 'boolean');
                    cases.push('explicit-fixture-setup');
                    button('Check native setup and open messages').click();
                    await wait(() => document.body.textContent.includes('Local private admission: protected-required'));
                    require(document.body.textContent.includes('Account: authenticated'));
                    cases.push('protected-admission');
                    await wait(() => enabled(document.querySelector('button[aria-label="Message Paired sailor"]')));
                    document.querySelector('button[aria-label="Message Paired sailor"]').click();
                    await wait(
                        () =>
                            document.querySelector('[role="log"]') &&
                            document.querySelector('input[aria-label="Message Paired sailor"]'),
                    );
                    require(rows(opener).length === (hostInitiates ? 0 : 1));
                    cases.push('actual-pm-open');
                    progress('pm-opened');
                    const compose = document.querySelector('input[aria-label="Message Paired sailor"]');
                    setInput(compose, outgoing);
                    await wait(() => enabled(document.querySelector('button[aria-label="Send direct message"]')));
                    document.querySelector('button[aria-label="Send direct message"]').click();
                    await wait(
                        () =>
                            rows(outgoing).length === 1 &&
                            statusOf(rows(outgoing)[0]).includes('Relay accepted') &&
                            document.querySelector('input[aria-label="Message Paired sailor"]')?.value === '',
                    );
                    require(document.querySelector('input[aria-label="Message Paired sailor"]')?.value === '');
                    cases.push('actual-pm-send');
                    progress('pm-sent');
                    control('protected-peer-reply');
                    await wait(() => peerReplied);
                    await wait(() => enabled(button('Refresh native messages')));
                    progress('pm-refresh-started');
                    button('Refresh native messages').click();
                    await wait(() => rows(incoming).length === 1);
                    require(rows(outgoing).length === 1 && rows(incoming).length === 1);
                    cases.push('actual-pm-receive');
                    progress('pm-received');
                    const incomingStatus = statusOf(rows(incoming)[0]);
                    require(
                        incomingStatus.includes('Time unknown') &&
                            incomingStatus.includes('Received') &&
                            incomingStatus.includes('Read status unknown'),
                    );
                    const outgoingStatus = statusOf(rows(outgoing)[0]);
                    require(
                        outgoingStatus.includes('Relay accepted') &&
                            !outgoingStatus.includes('Delivered') &&
                            !outgoingStatus.includes('Read status'),
                    );
                    require(document.body.textContent.includes('Encryption test—not reviewed') && secret.value === '');
                    require(counts.unexpected === 0 && !document.body.textContent.includes('Pending native relay'));
                    cases.push('truthful-status');
                    report('passed');
                })().catch(() => report('failed'));
            },
            { once: true },
        );
    } catch {
        report('failed');
    }
})();
