// @vitest-environment node
/**
 * Actual injected fixture JavaScript, executed in isolated jsdom windows with
 * a synthetic DOM/SDK fake and controlled timers. Ruby checks generate projects
 * only. No real React, Supabase SDK, Capacitor, Swift, Auth, encryption or device
 * execution is established by these tests; that needs the separate WK proof.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setImmediate as hostTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const NATIVE = fileURLToPath(new URL('../experiments/scuttlebutt-e2ee/bridge-native/', import.meta.url));
const SCRIPT = readFileSync(join(NATIVE, '../app-pilot/localUiFixture.js'), 'utf8');
const RUN_ID = '98000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://kmtupdvwdgbhtssqqova.supabase.co';
const OPEN_LABEL = 'Check native setup and open messages';
const BUNDLE = 'app.thalassa.research.scuttlebutt-auth';
const TEMP_PREFIX = 'thalassa-local-ui-generator-test-';
const cleanup: Array<() => void> = [];

// jsdom has no bundled TypeScript declarations in this checkout. Keep this
// narrow local interface instead of adding dependencies for test-only use.
type DomWindow = Window & typeof globalThis;
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
    JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => { window: DomWindow };
};
type Report = {
    version: number;
    runID: string;
    status: 'passed' | 'failed';
    assertions: number;
    sdkCounts: { password: number; unexpected: number };
    cases: string[];
};

async function settle() {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    await hostTurn();
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

async function domFixture(options: { clearPassword?: boolean } = {}) {
    const dom = new JSDOM(
        `<!doctype html><body>
        <p id="account-status">Account: signed_out · Local private admission: unknown</p>
        <p>Sending is blocked.</p>
        <form><input id="pilot-email" type="email"><input id="pilot-password" type="password">
        <button type="submit">Sign in and verify</button></form>
        <button id="open-messages" disabled>${OPEN_LABEL}</button>
        </body>`,
        { url: 'capacitor://localhost/', runScripts: 'outside-only' },
    );
    const win = dom.window;
    cleanup.push(() => win.close());
    // Let jsdom's own parsing events finish before installing the script, then
    // dispatch the fixture's one explicit DOMContentLoaded event ourselves.
    await new Promise<void>((resolve) => {
        if (win.document.readyState === 'complete') resolve();
        else win.addEventListener('load', () => resolve(), { once: true });
    });
    const reports: Report[] = [];
    Object.defineProperty(win, 'webkit', {
        value: {
            messageHandlers: {
                researchLocalUiFixture: {
                    postMessage: (report: Report | { status: 'progress' }) => {
                        if (report.status !== 'progress') reports.push(JSON.parse(JSON.stringify(report)) as Report);
                    },
                },
            },
        },
    });
    const originalFetch = vi.fn(async () => {
        throw new Error('Original network must not run in synthetic DOM test');
    });
    const originalXhr = vi.fn(function () {
        throw new Error('Original XHR must not run in synthetic DOM test');
    });
    const originalSocket = vi.fn(function () {
        throw new Error('Original socket must not run in synthetic DOM test');
    });
    const originalBeacon = vi.fn(() => false);
    Object.defineProperties(win, {
        fetch: { configurable: true, writable: true, value: originalFetch },
        XMLHttpRequest: { configurable: true, writable: true, value: originalXhr },
        WebSocket: { configurable: true, writable: true, value: originalSocket },
        Request: { configurable: true, value: Request },
        Response: { configurable: true, value: Response },
    });
    Object.defineProperty(win.navigator, 'sendBeacon', {
        configurable: true,
        writable: true,
        value: originalBeacon,
    });
    let now = 0,
        nextTimer = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    win.Date.now = () => now;
    win.setTimeout = ((handler: TimerHandler, timeout = 0) => {
        if (typeof handler !== 'function') throw new Error('String timer refused in synthetic DOM test');
        const id = ++nextTimer;
        timers.set(id, { at: now + Number(timeout), callback: () => handler() });
        return id;
    }) as DomWindow['setTimeout'];
    win.clearTimeout = ((id: number) => timers.delete(id)) as DomWindow['clearTimeout'];
    async function advance(milliseconds: number) {
        const end = now + milliseconds;
        for (;;) {
            const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].callback();
            await settle();
        }
        now = end;
        await settle();
    }
    const mail = win.document.getElementById('pilot-email') as HTMLInputElement;
    const secret = win.document.getElementById('pilot-password') as HTMLInputElement;
    const open = win.document.getElementById('open-messages') as HTMLButtonElement;
    const status = win.document.getElementById('account-status')!;
    const sdk = {
        signInWithPassword: vi.fn(async (credentials: { email: string; password: string }) => {
            // This fake drives the actual shim's password endpoint. It is not
            // Supabase SDK execution and never delegates to originalFetch.
            const response = await win.fetch(ORIGIN + '/auth/v1/token?grant_type=password', {
                method: 'POST',
                body: JSON.stringify({ ...credentials, gotrue_meta_security: {} }),
            });
            if (response.status !== 200) throw new Error('Synthetic Auth response refused');
        }),
    };
    const admissionRead = vi.fn();
    let completeAdmission: (() => void) | undefined;
    secret.form!.addEventListener('submit', (event) => {
        event.preventDefault();
        const credentials = { email: mail.value, password: secret.value };
        if (options.clearPassword !== false) secret.value = '';
        open.disabled = true;
        void sdk.signInWithPassword(credentials).then(() => {
            status.textContent = 'Account: authenticated · Local private admission: unknown';
            // Remain disabled until the test releases the simulated busy fence.
        });
    });
    open.addEventListener('click', () => {
        admissionRead();
        open.disabled = true;
        status.textContent = 'Account: authenticated · Local private admission: checking';
        completeAdmission = () => {
            status.textContent = 'Account: authenticated · Local private admission: unknown';
            open.disabled = false;
        };
    });
    win.eval(SCRIPT.replace('__RESEARCH_LOCAL_UI_RUN_ID__', RUN_ID));
    return {
        win,
        reports,
        sdk,
        admissionRead,
        originalFetch,
        originalXhr,
        originalSocket,
        originalBeacon,
        secret,
        open,
        status,
        advance,
        async start() {
            win.dispatchEvent(new win.Event('DOMContentLoaded'));
            await settle();
            await advance(0);
        },
        releaseBusy() {
            open.disabled = false;
        },
        releaseAdmission() {
            if (!completeAdmission) throw new Error('Synthetic admission was not explicitly requested');
            completeAdmission();
        },
    };
}

afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe('executed local UI shim — jsdom and SDK fake only', () => {
    it('refuses unexpected fetch, XHR, WebSocket and beacon without invoking originals', async () => {
        const f = await domFixture();
        await expect(f.win.fetch('https://fixture.invalid/forbidden')).rejects.toThrow(
            'Local UI fixture network refused',
        );
        await expect(f.win.fetch(ORIGIN + '/auth/v1/token?grant_type=password')).rejects.toThrow(
            'Local UI fixture network refused',
        );
        await expect(
            f.win.fetch(ORIGIN + '/auth/v1/token?grant_type=password', {
                method: 'POST',
                body: JSON.stringify({ email: 'synthetic.invalid', password: 'synthetic-only' }),
            }),
        ).rejects.toThrow('Local UI fixture network refused');
        expect(() => new f.win.XMLHttpRequest()).toThrow('Local UI fixture network refused');
        expect(() => new f.win.WebSocket('wss://fixture.invalid')).toThrow('Local UI fixture network refused');
        expect(() => f.win.navigator.sendBeacon('https://fixture.invalid')).toThrow('Local UI fixture network refused');
        for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket']) {
            expect(Object.getOwnPropertyDescriptor(f.win, name)).toMatchObject({
                configurable: false,
                writable: false,
            });
            expect(Reflect.set(f.win, name, () => undefined)).toBe(false);
        }
        expect(Object.getOwnPropertyDescriptor(f.win.navigator, 'sendBeacon')).toMatchObject({
            configurable: false,
            writable: false,
        });
        expect(f.originalFetch).not.toHaveBeenCalled();
        expect(f.originalXhr).not.toHaveBeenCalled();
        expect(f.originalSocket).not.toHaveBeenCalled();
        expect(f.originalBeacon).not.toHaveBeenCalled();
    });

    it('waits through authenticated busy state, then checks unknown once and reports password clearing', async () => {
        const f = await domFixture();
        await f.start();
        expect(f.sdk.signInWithPassword).toHaveBeenCalledTimes(1);
        expect(f.status.textContent).toContain('Account: authenticated');
        expect(f.open.disabled).toBe(true);
        await f.advance(250);
        expect(f.admissionRead).not.toHaveBeenCalled();
        expect(f.reports).toHaveLength(0);
        f.releaseBusy();
        await f.advance(50);
        expect(f.admissionRead).toHaveBeenCalledTimes(1);
        expect(f.status.textContent).toContain('Local private admission: checking');
        expect(f.reports).toHaveLength(0);
        f.releaseAdmission();
        await f.advance(50);
        expect(f.secret.value).toBe('');
        expect(f.win.document.querySelector('[role="log"], [role="listitem"]')).toBeNull();
        expect(f.reports).toHaveLength(1);
        expect(f.reports[0]).toMatchObject({
            version: 1,
            runID: RUN_ID,
            status: 'passed',
            sdkCounts: { password: 1, unexpected: 0 },
            cases: ['cold-denied', 'sign-in', 'unknown-admission', 'no-private-open', 'password-cleared'],
        });
        expect(f.reports[0].assertions).toBeGreaterThan(0);
        f.win.dispatchEvent(new f.win.Event('DOMContentLoaded'));
        await f.advance(100);
        expect(f.sdk.signInWithPassword).toHaveBeenCalledTimes(1);
        expect(f.admissionRead).toHaveBeenCalledTimes(1);
        expect(f.reports).toHaveLength(1);
        expect(f.originalFetch).not.toHaveBeenCalled();
    });

    it('refuses a success report when the password is retained', async () => {
        const f = await domFixture({ clearPassword: false });
        await f.start();
        f.releaseBusy();
        await f.advance(50);
        expect(f.admissionRead).not.toHaveBeenCalled();
        expect(f.reports).toHaveLength(1);
        expect(f.reports[0]).toMatchObject({ status: 'failed', cases: ['fixture-failed'] });
    });

    it.each(['log', 'listitem'])('refuses success when unknown admission exposes a chat %s', async (role) => {
        const f = await domFixture();
        await f.start();
        f.releaseBusy();
        await f.advance(50);
        const chat = f.win.document.createElement('div');
        chat.setAttribute('role', role);
        f.win.document.body.append(chat);
        f.releaseAdmission();
        await f.advance(50);
        expect(f.admissionRead).toHaveBeenCalledTimes(1);
        expect(f.reports).toHaveLength(1);
        expect(f.reports[0]).toMatchObject({ status: 'failed', cases: ['fixture-failed'] });
    });
});

function ordinarySwift(source: string): string {
    const stack: Array<{ parent: boolean; selected: boolean }> = [];
    const output: string[] = [];
    let active = true;
    for (const line of source.split('\n')) {
        const directive = line.trim();
        if (directive.startsWith('#if ')) {
            const flag = directive.slice(4);
            if (!['E2EE_LOCAL_UI_FIXTURE', 'E2EE_PROTECTED_UI_FIXTURE'].includes(flag))
                throw new Error('Unknown fixture flag');
            stack.push({ parent: active, selected: false });
            active = false;
        } else if (directive === '#else') {
            const frame = stack.at(-1);
            if (!frame) throw new Error('Unbalanced fixture branch');
            active = frame.parent && !frame.selected;
        } else if (directive === '#endif') {
            const frame = stack.pop();
            if (!frame) throw new Error('Unbalanced fixture branch');
            active = frame.parent;
        } else if (active) output.push(line);
    }
    if (stack.length) throw new Error('Unclosed fixture branch');
    return output.join('\n');
}

describe('local UI isolation source contracts — no Swift compilation', () => {
    it('excludes every fixture hook from ordinary Swift branches and build inputs', () => {
        for (const name of ['ResearchApp.swift', 'ResearchAuthHost.swift', 'ScuttlebuttResearchAuthPlugin.swift']) {
            expect(ordinarySwift(readFileSync(join(NATIVE, name), 'utf8'))).not.toContain('ResearchLocalUiFixture');
        }
        const host = ordinarySwift(readFileSync(join(NATIVE, 'ResearchAuthHost.swift'), 'utf8'));
        expect(host).toContain('VodozemacSupabaseAuth(projectOrigin: origin, publicApiKey: key)');
        const plugin = ordinarySwift(readFileSync(join(NATIVE, 'ScuttlebuttResearchAuthPlugin.swift'), 'utf8'));
        expect(plugin).toContain('VodozemacRelayTransport(serviceOrigin: ResearchAuthConfiguration.origin');
        const build = readFileSync(join(NATIVE, 'build.mjs'), 'utf8');
        expect(build).toMatch(
            /if\s*\(localUiFile\)\s*sourcePaths\.push\(join\(HERE,\s*'ResearchLocalUiFixture.swift'\)\)/,
        );
        expect(build).toContain("'SWIFT_ACTIVE_COMPILATION_CONDITIONS=E2EE_LOCAL_UI_FIXTURE'");
        expect(build).toContain("protectedUi ? ' E2EE_PROTECTED_UI_FIXTURE' : ''");
    });

    it('refuses a mistakenly flagged physical runtime and intercepts all native requests', () => {
        const source = readFileSync(join(NATIVE, 'ResearchLocalUiFixture.swift'), 'utf8');
        expect(source).toMatch(/^#if E2EE_LOCAL_UI_FIXTURE$/m);
        const platform = source.match(/#if targetEnvironment\(simulator\)([\s\S]*?)#else([\s\S]*?)#endif/);
        expect(platform).not.toBeNull();
        expect(platform![2]).toMatch(/throw ResearchLocalUiFixtureError\.unavailable/);
        expect(platform![2]).not.toMatch(/URLSession|VodozemacSupabaseAuth|runID\s*=/);
        expect(source.match(/canInit\(with request: URLRequest\) -> Bool \{ true \}/g)).toHaveLength(2);
        expect(source).toContain('configuration.protocolClasses = [ResearchLocalUiAuthProtocol.self]');
        expect(source).toContain('configuration.protocolClasses = [ResearchLocalUiRelayProtocol.self]');
        expect(source).toContain('guard !markerPresent, !rootExists');
    });
});

function generate(platform: 'iphoneos' | 'iphonesimulator', additional: Record<string, unknown> = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), TEMP_PREFIX)));
    chmodSync(root, 0o700);
    cleanup.push(() => {
        if (dirname(root) !== realpathSync(tmpdir()) || !basename(root).startsWith(TEMP_PREFIX))
            throw new Error('Unsafe local generator fixture cleanup target');
        rmSync(root, { recursive: true, force: false });
    });
    for (const name of [
        'Sources',
        'Bindings',
        'Provider',
        'public',
        'Frameworks/Capacitor.framework',
        'Frameworks/Cordova.framework',
    ])
        mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
    const write = (name: string, content: string) =>
        writeFileSync(join(root, name), content, { mode: 0o600, flag: 'wx' });
    const sources = ['ResearchApp.swift', 'ResearchAuthHost.swift', 'ScuttlebuttResearchAuthPlugin.swift'];
    for (const name of sources) write('Sources/' + name, '// Synthetic generator input; never compiled.\n');
    write('Bindings/fixture.swift', '// Synthetic generator input; never compiled.\n');
    write('Bindings/fixture.modulemap', '// Synthetic generator input; never compiled.\n');
    write('Provider/libthalassa_vodozemac_native.a', 'synthetic archive placeholder\n');
    write('public/index.html', '<!doctype html><title>Synthetic generator input only</title>');
    for (const name of ['capacitor.config.json', 'research-config.json', 'research-local-ui-fixture.json'])
        write(name, '{}');
    write('research.simulated.xcent', '<plist><dict/></plist>');
    write('research.simulated.xcent.der', 'synthetic simulator section placeholder');
    write('config.xml', '<widget/>');
    const manifest = join(root, 'generator-input.json');
    write(
        'generator-input.json',
        JSON.stringify({
            projectRoot: root,
            bundleId: BUNDLE,
            platform,
            sources,
            bindingSwift: 'fixture.swift',
            moduleMap: 'fixture.modulemap',
            ...additional,
        }),
    );
    const result = spawnSync('/opt/homebrew/opt/ruby/bin/ruby', [join(NATIVE, 'generate_project.rb'), manifest], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
    });
    expect(result.error, 'existing local Ruby/xcodeproj runtime is required; never install or skip').toBeUndefined();
    expect(result.signal).toBeNull();
    return { result, root };
}

describe('actual local Ruby generator flag contracts — generation only', () => {
    it.each([{}, { localUiFixture: false }])(
        'keeps default manifests free of the fixture resource: %j',
        (additional) => {
            const { result, root } = generate('iphoneos', additional);
            expect(result.status).toBe(0);
            const project = readFileSync(join(root, 'ScuttlebuttResearchAuth.xcodeproj/project.pbxproj'), 'utf8');
            expect(project).not.toContain('research-local-ui-fixture.json');
            expect(project).not.toContain('ResearchLocalUiFixture.swift');
            expect(project).not.toContain('E2EE_LOCAL_UI_FIXTURE');
        },
    );
    it('includes only explicitly requested simulator fixture resources', () => {
        const { result, root } = generate('iphonesimulator', { localUiFixture: true });
        expect(result.status).toBe(0);
        const project = readFileSync(join(root, 'ScuttlebuttResearchAuth.xcodeproj/project.pbxproj'), 'utf8');
        expect(project).toContain('research-local-ui-fixture.json');
    });
    it.each([null, 0, 1, 'false', 'true'])('rejects nonboolean localUiFixture %j', (localUiFixture) => {
        expect(generate('iphonesimulator', { localUiFixture }).result.status).toBe(1);
    });
    it('refuses fixture generation for a physical target and unknown manifest keys', () => {
        expect(generate('iphoneos', { localUiFixture: true }).result.status).toBe(1);
        expect(generate('iphonesimulator', { localUiFixture: false, unexpected: true }).result.status).toBe(1);
    });
});
