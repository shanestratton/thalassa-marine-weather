// @vitest-environment node
/** Actual protectedUiFixture.js in fresh jsdom windows with a synthetic DOM,
 * SDK and native-control fake. PM actions use ordinary DOM buttons in this fake
 * model; no native PM API is invoked. This is NOT real React/SDK/Capacitor/native
 * or encryption evidence. The separate simulator proof establishes that path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as hostTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const NATIVE = fileURLToPath(new URL('../experiments/scuttlebutt-e2ee/bridge-native/', import.meta.url));
const SCRIPT = readFileSync(join(NATIVE, '../app-pilot/protectedUiFixture.js'), 'utf8');
const RUN_ID = '99000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://kmtupdvwdgbhtssqqova.supabase.co';
const OUTGOING = 'Protected UI outgoing canary';
const INCOMING = 'Protected UI peer canary';
const OPENER = 'Protected UI opener canary';
const INCOMING_STATUS = 'Time unknown · Received · Read status unknown';
const OUTGOING_STATUS = 'Relay accepted';
type DomWindow = Window & typeof globalThis;
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => { window: DomWindow };
};
type Signal = { version: 1; runID: string; status: 'progress' | 'control'; phase: string };
type Terminal = {
    version: 1;
    runID: string;
    status: 'passed' | 'failed';
    assertions: number;
    sdkCounts: { password: number; unexpected: number };
    cases: string[];
    domFacts: {
        logPresent: boolean;
        outgoingCount: number;
        outgoingAccepted: boolean;
        composeEmpty: boolean;
        unavailableNotice: boolean;
        closedNotice: boolean;
    };
};
type Capture = Signal | Terminal;
type Options = {
    hostInitiates?: boolean;
    incomingStatus?: string;
    outgoingStatus?: string;
    draftClearDelayMs?: number;
    remountComposeAfterAccepted?: boolean;
    login?: 'wrong-password' | 'invalid-json' | 'extra-field';
    setupSignal?: unknown;
    replySignal?: unknown;
    duplicateSetupSignal?: boolean;
};
const disposals: Array<() => void> = [];
const PASSED_DOM_FACTS: Terminal['domFacts'] = {
    logPresent: true,
    outgoingCount: 1,
    outgoingAccepted: true,
    composeEmpty: true,
    unavailableNotice: false,
    closedNotice: false,
};
function expectFixedDomFacts(facts: Terminal['domFacts']) {
    expect(Object.keys(facts).sort()).toEqual([
        'closedNotice',
        'composeEmpty',
        'logPresent',
        'outgoingAccepted',
        'outgoingCount',
        'unavailableNotice',
    ]);
    expect(Number.isInteger(facts.outgoingCount)).toBe(true);
    expect(facts.outgoingCount).toBeGreaterThanOrEqual(0);
    expect(facts.outgoingCount).toBeLessThanOrEqual(16);
    for (const key of ['logPresent', 'outgoingAccepted', 'composeEmpty', 'unavailableNotice', 'closedNotice'] as const)
        expect(typeof facts[key]).toBe('boolean');
}
async function settle() {
    for (let count = 0; count < 20; count += 1) await Promise.resolve();
    await hostTurn();
    for (let count = 0; count < 20; count += 1) await Promise.resolve();
}

async function fixture(options: Options = {}) {
    const dom = new JSDOM(
        `<!doctype html><body>
        <p id="status">Account: signed_out · Local private admission: unknown</p>
        <p>Sending is blocked.</p><p>Encryption test—not reviewed</p>
        <form><input id="pilot-email"><input id="pilot-password" type="password">
        <button type="submit">Sign in and verify</button></form>
        <button id="open" disabled>Check native setup and open messages</button>
        <section id="pm"></section></body>`,
        { url: 'capacitor://localhost/', runScripts: 'outside-only' },
    );
    const win = dom.window;
    const originals = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    disposals.push(() => {
        win.close();
        for (const original of originals) expect(original).not.toHaveBeenCalled();
    });
    await new Promise<void>((resolve) => {
        if (win.document.readyState === 'complete') resolve();
        else win.addEventListener('load', () => resolve(), { once: true });
    });
    Object.defineProperties(win, {
        fetch: { configurable: true, writable: true, value: originals[0] },
        XMLHttpRequest: { configurable: true, writable: true, value: originals[1] },
        WebSocket: { configurable: true, writable: true, value: originals[2] },
        Request: { configurable: true, value: Request },
        Response: { configurable: true, value: Response },
    });
    Object.defineProperty(win.navigator, 'sendBeacon', { configurable: true, writable: true, value: originals[3] });
    const captures: Capture[] = [];
    const actions = { submit: 0, open: 0, peer: 0, send: 0, refresh: 0 };
    const role = options.hostInitiates ?? true;
    let retiredCompose: HTMLInputElement | undefined;
    let now = 0,
        nextTimer = 0,
        replyAvailable = false;
    const timers = new Map<number, { at: number; callback: () => void }>();
    win.Date.now = () => now;
    win.setTimeout = ((handler: TimerHandler, timeout = 0) => {
        if (typeof handler !== 'function') throw new Error('String timer refused in synthetic protected DOM');
        const id = ++nextTimer;
        timers.set(id, { at: now + Number(timeout), callback: () => handler() });
        return id;
    }) as DomWindow['setTimeout'];
    win.clearTimeout = ((id: number) => timers.delete(id)) as DomWindow['clearTimeout'];
    const signal = (detail: unknown) =>
        win.dispatchEvent(new win.CustomEvent('research-protected-ui-step', { detail }));
    Object.defineProperty(win, 'webkit', {
        value: {
            messageHandlers: {
                researchLocalUiFixture: {
                    postMessage: (value: Capture) => {
                        const captured = JSON.parse(JSON.stringify(value)) as Capture;
                        captures.push(captured);
                        if (captured.status === 'passed' || captured.status === 'failed')
                            expectFixedDomFacts(captured.domFacts);
                        if (captured.status !== 'control') return;
                        if (captured.phase === 'protected-setup') {
                            const detail = Object.hasOwn(options, 'setupSignal')
                                ? options.setupSignal
                                : { phase: 'prepared', hostInitiates: role };
                            signal(detail);
                            if (options.duplicateSetupSignal) signal(detail);
                        } else if (captured.phase === 'protected-peer-reply') {
                            replyAvailable = true;
                            signal(
                                Object.hasOwn(options, 'replySignal') ? options.replySignal : { phase: 'peer-replied' },
                            );
                        }
                    },
                },
            },
        },
    });
    const status = win.document.getElementById('status')!;
    const secret = win.document.getElementById('pilot-password') as HTMLInputElement;
    const email = win.document.getElementById('pilot-email') as HTMLInputElement;
    const open = win.document.getElementById('open') as HTMLButtonElement;
    const panel = win.document.getElementById('pm')!;
    const sdk = vi.fn(async (credentials: { email: string; password: string }) => {
        const body =
            options.login === 'invalid-json'
                ? '{'
                : JSON.stringify({
                      ...credentials,
                      ...(options.login === 'wrong-password' ? { password: 'synthetic-wrong-password' } : {}),
                      ...(options.login === 'extra-field' ? { forbidden: true } : {}),
                      gotrue_meta_security: {},
                  });
        const response = await win.fetch(ORIGIN + '/auth/v1/token?grant_type=password', { method: 'POST', body });
        if (response.status !== 200) throw new Error('Synthetic SDK response refused');
    });
    secret.form!.addEventListener('submit', (event) => {
        event.preventDefault();
        actions.submit += 1;
        const credentials = { email: email.value, password: secret.value };
        secret.value = '';
        void sdk(credentials)
            .then(() => {
                status.textContent = 'Account: authenticated · Local private admission: unknown';
                open.disabled = false;
            })
            .catch(() => {
                status.textContent = 'Account: unavailable';
            });
    });
    function row(text: string, display: string) {
        const item = win.document.createElement('div');
        const paragraph = win.document.createElement('p');
        paragraph.textContent = text;
        const state = win.document.createElement('span');
        state.textContent = display;
        item.append(paragraph, state);
        panel.querySelector('[role="log"]')!.append(item);
    }
    open.addEventListener('click', () => {
        actions.open += 1;
        status.textContent = 'Account: authenticated · Local private admission: protected-required';
        const peer = win.document.createElement('button');
        peer.setAttribute('aria-label', 'Message Paired sailor');
        peer.textContent = 'Paired sailor';
        peer.addEventListener('click', () => {
            actions.peer += 1;
            panel.innerHTML =
                '<div role="log"></div><input aria-label="Message Paired sailor"><button aria-label="Send direct message" disabled>Send</button><button>Refresh native messages</button>';
            if (!role) row(OPENER, INCOMING_STATUS);
            const compose = panel.querySelector('input') as HTMLInputElement;
            const send = panel.querySelector('[aria-label="Send direct message"]') as HTMLButtonElement;
            compose.addEventListener('input', () => {
                send.disabled = compose.value.length === 0;
            });
            // These are DOM-only fake model actions. They never invoke a PM
            // bridge/plugin/native shortcut or relay API.
            send.addEventListener('click', () => {
                actions.send += 1;
                row(compose.value, options.outgoingStatus ?? OUTGOING_STATUS);
                send.disabled = true;
                let currentCompose = compose;
                if (options.remountComposeAfterAccepted) {
                    // Retire the original node with its old draft intact. The
                    // driver must observe the current field after settlement.
                    retiredCompose = compose;
                    currentCompose = compose.cloneNode(true) as HTMLInputElement;
                    currentCompose.value = compose.value;
                    compose.replaceWith(currentCompose);
                }
                if (options.draftClearDelayMs) {
                    // A subscription can render acceptance while the simulated
                    // send promise still owns the draft. Release only when this
                    // controlled timer fires, as the real UI does on settlement.
                    win.setTimeout(() => {
                        currentCompose.value = '';
                    }, options.draftClearDelayMs);
                } else currentCompose.value = '';
            });
            panel.querySelectorAll('button')[1].addEventListener('click', () => {
                actions.refresh += 1;
                if (replyAvailable) row(INCOMING, options.incomingStatus ?? INCOMING_STATUS);
            });
        });
        panel.append(peer);
    });
    win.eval(SCRIPT.replace('__RESEARCH_LOCAL_UI_RUN_ID__', RUN_ID));
    async function advance(milliseconds: number) {
        const deadline = now + milliseconds;
        for (;;) {
            const due = [...timers].filter(([, timer]) => timer.at <= deadline).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].callback();
            await settle();
        }
        now = deadline;
        await settle();
    }
    return {
        win,
        actions,
        sdk,
        captures,
        secret,
        signal,
        advance,
        retiredCompose: () => retiredCompose,
        terminals: () =>
            captures.filter((value): value is Terminal => value.status === 'passed' || value.status === 'failed'),
        controls: () => captures.filter((value): value is Signal => value.status === 'control'),
        async start() {
            win.dispatchEvent(new win.Event('DOMContentLoaded'));
            await settle();
            await advance(0);
        },
    };
}
afterEach(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
});

describe('actual protected fixture JS — jsdom SDK/control/PM DOM fakes only', () => {
    it.each([true, false])('drives ordinary buttons with hostInitiates=%s and reports once', async (hostInitiates) => {
        const f = await fixture({ hostInitiates });
        expect(f.actions).toEqual({ submit: 0, open: 0, peer: 0, send: 0, refresh: 0 });
        await f.start();
        await f.advance(100);
        expect(f.sdk).toHaveBeenCalledTimes(1);
        expect(f.actions).toEqual({ submit: 1, open: 1, peer: 1, send: 1, refresh: 1 });
        expect(f.secret.value).toBe('');
        expect(f.controls().map((value) => value.phase)).toEqual(['protected-setup', 'protected-peer-reply']);
        for (const value of f.controls()) {
            expect(Object.keys(value).sort()).toEqual(['phase', 'runID', 'status', 'version']);
            expect(value).toMatchObject({ version: 1, runID: RUN_ID, status: 'control' });
        }
        expect(f.terminals()).toHaveLength(1);
        expect(f.terminals()[0]).toMatchObject({
            version: 1,
            runID: RUN_ID,
            status: 'passed',
            sdkCounts: { password: 1, unexpected: 0 },
            domFacts: PASSED_DOM_FACTS,
            cases: [
                'cold-denied',
                'sign-in',
                'explicit-fixture-setup',
                'protected-admission',
                'actual-pm-open',
                'actual-pm-send',
                'actual-pm-receive',
                'truthful-status',
            ],
        });
        expect(Object.keys(f.terminals()[0]).sort()).toEqual([
            'assertions',
            'cases',
            'domFacts',
            'runID',
            'sdkCounts',
            'status',
            'version',
        ]);
        expect(f.terminals()[0].assertions).toBeGreaterThan(0);
        const paragraphs = [...f.win.document.querySelectorAll('[role="log"] p')].map((node) => node.textContent);
        expect(paragraphs).toEqual(hostInitiates ? [OUTGOING, INCOMING] : [OPENER, OUTGOING, INCOMING]);
        expect(f.win).not.toHaveProperty('Capacitor');
        f.win.dispatchEvent(new f.win.Event('DOMContentLoaded'));
        await f.advance(100);
        expect(f.terminals()).toHaveLength(1);
        expect(f.actions.send).toBe(1);
    });

    it.each([true, false])('waits for delayed draft clearing with hostInitiates=%s', async (hostInitiates) => {
        const f = await fixture({ hostInitiates, draftClearDelayMs: 500 });
        await f.start();
        await f.advance(100);
        expect(f.actions.send).toBe(1);
        const outgoing = [...f.win.document.querySelectorAll('[role="log"] p')].filter(
            (node) => node.textContent === OUTGOING,
        );
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0].parentElement?.textContent).toContain('Relay accepted');
        const compose = f.win.document.querySelector('input[aria-label="Message Paired sailor"]') as HTMLInputElement;
        expect(compose.value).toBe(OUTGOING);
        expect(f.controls().map((value) => value.phase)).toEqual(['protected-setup']);
        expect(f.actions.refresh).toBe(0);
        expect(f.terminals()).toHaveLength(0);
        await f.advance(250);
        expect(compose.value).toBe(OUTGOING);
        expect(f.controls().map((value) => value.phase)).toEqual(['protected-setup']);
        expect(f.terminals()).toHaveLength(0);
        await f.advance(500);
        expect(compose.value).toBe('');
        expect(f.controls().map((value) => value.phase)).toEqual(['protected-setup', 'protected-peer-reply']);
        expect(f.actions.send).toBe(1);
        expect(f.actions.refresh).toBe(1);
        expect(f.terminals()).toHaveLength(1);
        expect(f.terminals()[0]).toMatchObject({ status: 'passed', sdkCounts: { password: 1, unexpected: 0 } });
        expect(f.terminals()[0].domFacts).toEqual(PASSED_DOM_FACTS);
    });

    it.each([true, false])('observes the current remounted compose with hostInitiates=%s', async (hostInitiates) => {
        const f = await fixture({ hostInitiates, draftClearDelayMs: 500, remountComposeAfterAccepted: true });
        await f.start();
        await f.advance(100);
        const current = f.win.document.querySelector('input[aria-label="Message Paired sailor"]') as HTMLInputElement;
        const retired = f.retiredCompose();
        expect(retired).toBeDefined();
        expect(retired?.isConnected).toBe(false);
        expect(current).not.toBe(retired);
        expect(current.value).toBe(OUTGOING);
        expect(retired?.value).toBe(OUTGOING);
        expect(f.controls().map((value) => value.phase)).toEqual(['protected-setup']);
        expect(f.terminals()).toHaveLength(0);
        await f.advance(600);
        expect(current.value).toBe('');
        expect(retired?.value).toBe(OUTGOING);
        expect(f.actions).toEqual({ submit: 1, open: 1, peer: 1, send: 1, refresh: 1 });
        expect(f.controls().map((value) => value.phase)).toEqual(['protected-setup', 'protected-peer-reply']);
        expect(f.terminals()).toHaveLength(1);
        expect(f.terminals()[0]).toMatchObject({ status: 'passed', domFacts: PASSED_DOM_FACTS });
    });

    it.each([
        null,
        { phase: 'prepared' },
        { phase: 'prepared', hostInitiates: 'true' },
        { phase: 'prepared', hostInitiates: true, extra: true },
        { phase: 'peer-replied' },
    ])('refuses malformed/out-of-order setup signal %j', async (setupSignal) => {
        const f = await fixture({ setupSignal });
        await f.start();
        await f.advance(100);
        expect(f.terminals()).toHaveLength(1);
        expect(f.terminals()[0]).toMatchObject({ status: 'failed', cases: ['fixture-failed'] });
        expect(f.actions.open).toBe(0);
        expect(f.actions.send).toBe(0);
    });
    it('refuses duplicate setup completion and extra reply signal fields', async () => {
        for (const options of [
            { duplicateSetupSignal: true },
            { replySignal: { phase: 'peer-replied', extra: true } },
        ]) {
            const f = await fixture(options);
            await f.start();
            await f.advance(100);
            expect(f.terminals()).toHaveLength(1);
            expect(f.terminals()[0]).toMatchObject({ status: 'failed', cases: ['fixture-failed'] });
            expect(f.actions.refresh).toBe(0);
        }
    });
    it.each(['wrong-password', 'invalid-json', 'extra-field'] as const)(
        'refuses malformed synthetic login %s',
        async (login) => {
            const f = await fixture({ login });
            await f.start();
            await f.advance(20100);
            expect(f.terminals()).toHaveLength(1);
            expect(f.terminals()[0]).toMatchObject({ status: 'failed', cases: ['fixture-failed'] });
            expect(f.controls()).toHaveLength(0);
            expect(f.actions.send).toBe(0);
        },
    );
    it.each([
        { incomingStatus: '12:34 · Received · Read status unknown' },
        { incomingStatus: 'Time unknown · Delivered · Read status unknown' },
        { incomingStatus: 'Time unknown · Received · Read' },
        { outgoingStatus: 'Relay accepted · Delivered' },
        { outgoingStatus: 'Relay accepted · Read status known' },
    ])('refuses dishonest display evidence %j', async (options) => {
        const f = await fixture(options);
        await f.start();
        await f.advance(100);
        expect(f.actions.send).toBe(1);
        expect(f.actions.refresh).toBe(1);
        expect(f.terminals()).toHaveLength(1);
        expect(f.terminals()[0]).toMatchObject({ status: 'failed', cases: ['fixture-failed'] });
    });
    it('blocks all original network entry points and refuses success after an unexpected request', async () => {
        const f = await fixture();
        await expect(f.win.fetch('https://fixture.invalid/blocked')).rejects.toThrow(
            'Protected UI fixture network refused',
        );
        expect(() => new f.win.XMLHttpRequest()).toThrow('Protected UI fixture network refused');
        expect(() => new f.win.WebSocket('wss://fixture.invalid')).toThrow('Protected UI fixture network refused');
        expect(() => f.win.navigator.sendBeacon('https://fixture.invalid')).toThrow(
            'Protected UI fixture network refused',
        );
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket'])
            expect(Object.getOwnPropertyDescriptor(f.win, name)).toMatchObject({
                configurable: false,
                writable: false,
            });
        await f.start();
        await f.advance(100);
        expect(f.terminals()).toHaveLength(1);
        expect(f.terminals()[0]).toMatchObject({ status: 'failed', sdkCounts: { password: 1, unexpected: 4 } });
    });
});

// Source contracts only. Respect nested #if/#else boundaries; a greedy regex
// would accidentally erase simulator refusal or the cold scenario branch.
function scenario(source: string, flags: Record<string, boolean>) {
    const stack: Array<{ parent: boolean; condition: boolean; seenElse: boolean }> = [];
    let active = true;
    const output: string[] = [];
    for (const line of source.split('\n')) {
        const directive = line.trim();
        if (directive.startsWith('#if ')) {
            const condition = directive.slice(4);
            if (!Object.hasOwn(flags, condition)) throw new Error('Unknown source-contract condition');
            stack.push({ parent: active, condition: flags[condition], seenElse: false });
            active = active && flags[condition];
        } else if (directive === '#else') {
            const frame = stack.at(-1);
            if (!frame || frame.seenElse) throw new Error('Invalid source-contract else');
            frame.seenElse = true;
            active = frame.parent && !frame.condition;
        } else if (directive === '#endif') {
            const frame = stack.pop();
            if (!frame) throw new Error('Unbalanced source-contract endif');
            active = frame.parent;
        } else if (active) output.push(line);
    }
    if (stack.length) throw new Error('Unclosed source-contract condition');
    return output.join('\n');
}
const FLAGS = { E2EE_LOCAL_UI_FIXTURE: true, E2EE_PROTECTED_UI_FIXTURE: true, 'targetEnvironment(simulator)': true };
describe('protected fixture source contracts — no compilation/native execution', () => {
    it('keeps v2 protected scenario and cold v1 scenario separate under nested flags', () => {
        const source = readFileSync(join(NATIVE, 'ResearchLocalUiFixture.swift'), 'utf8');
        const protectedSource = scenario(source, FLAGS);
        const coldSource = scenario(source, { ...FLAGS, E2EE_PROTECTED_UI_FIXTURE: false });
        expect(protectedSource).toContain('Self.integer(input["version"], 2...2) == 2');
        expect(protectedSource).toContain('input["scenario"] as? String == "protected-exchange"');
        expect(protectedSource).toContain('private static let allowed = coldAllowed.union(');
        expect(coldSource).toContain('Self.integer(input["version"], 1...1) == 1');
        expect(coldSource).toContain('private static let allowed = coldAllowed');
        expect(coldSource).not.toContain('coldAllowed.union(');
        expect(coldSource).not.toContain('ResearchProtectedUiRelay');
        expect(coldSource).not.toContain('startProtectedControl');
        expect(coldSource).toContain('counters["nativeAuthRequests"] == 2');
        expect(coldSource).toContain('configuration.protocolClasses = [ResearchLocalUiAuthProtocol.self]');
        expect(scenario(source, { ...FLAGS, E2EE_LOCAL_UI_FIXTURE: false })).not.toContain(
            'class ResearchLocalUiFixture',
        );
        const build = readFileSync(join(NATIVE, 'build.mjs'), 'utf8');
        expect(build).toContain("(protectedUi ? ' E2EE_PROTECTED_UI_FIXTURE' : '')");
        expect(build).toMatch(
            /if\s*\(protectedUi\)\s*sourcePaths\.push\(join\(HERE,\s*'ResearchProtectedUiRelay.swift'\),\s*join\(HERE,\s*'ResearchProtectedUiFixture.swift'\)\)/,
        );
        expect(build).toContain("protectedUi ? 'app-pilot/protectedUiFixture.js' : 'app-pilot/localUiFixture.js'");
    });
    it('preserves ordinary Auth/relay constructors and refuses flagged physical execution', () => {
        for (const name of ['ResearchAuthHost.swift', 'ScuttlebuttResearchAuthPlugin.swift']) {
            const ordinary = scenario(readFileSync(join(NATIVE, name), 'utf8'), {
                ...FLAGS,
                E2EE_LOCAL_UI_FIXTURE: false,
                E2EE_PROTECTED_UI_FIXTURE: false,
            });
            expect(ordinary).not.toContain('ResearchLocalUiFixture');
            expect(ordinary).not.toContain('ResearchProtectedUi');
            expect(ordinary).toContain(
                name.startsWith('ResearchAuthHost')
                    ? 'VodozemacSupabaseAuth(projectOrigin: origin'
                    : 'VodozemacRelayTransport(serviceOrigin: ResearchAuthConfiguration.origin',
            );
        }
        const physical = scenario(readFileSync(join(NATIVE, 'ResearchLocalUiFixture.swift'), 'utf8'), {
            ...FLAGS,
            'targetEnvironment(simulator)': false,
        });
        expect(physical).toContain('A mistakenly flagged physical build must refuse');
        expect(physical).not.toContain('runID = id; script = source');
        const relay = readFileSync(join(NATIVE, 'ResearchProtectedUiRelay.swift'), 'utf8');
        expect(relay).toContain('configuration.protocolClasses = [ResearchProtectedUiRelayProtocol.self]');
        expect(relay).toContain('canInit(with request: URLRequest) -> Bool { true }');
    });
    it('uses original host/peer snapshots and peer-only send/inbox helper operations', () => {
        const source = readFileSync(join(NATIVE, 'ResearchProtectedUiFixture.swift'), 'utf8');
        expect(source).toContain('host = try Actor(facade: facade, account: account');
        expect(source).toContain('facade.currentAccount() == account');
        expect(source).toContain('facade.currentMessageContext(snapshot: owner) == owner.context');
        expect(source).toContain('host.account.deviceId.utf8.lexicographicallyPrecedes(other.account.deviceId.utf8)');
        expect(source).toContain('ResearchPrivateMessageAdapter(facade: other.facade');
        expect(source).not.toMatch(
            /host\.(?:control|facade)\.(?:sendText|sendPending|syncInbox|inbox|prepareText)\s*\(/,
        );
        expect(source).not.toContain('.privateMessagePrepareText(');
        expect(source).toContain(
            'hostOutgoing.envelopeSha256 == outgoingHash && peerIncoming.envelopeSha256 == outgoingHash',
        );
        expect(source).toContain('methods["unexpected"] == 0');
        expect(source).toContain('auth["host"] == 2 && auth["peer"] == 2');
    });
});
