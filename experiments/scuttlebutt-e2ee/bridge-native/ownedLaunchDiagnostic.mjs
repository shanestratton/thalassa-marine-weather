import { Buffer } from 'node:buffer';
import { types } from 'node:util';

// Diagnostics of an already returned owned-simulator launch only. Neither a
// matching PID nor any other scalar here grants native admission or acceptance.
const refusal = 'Owned simulator launch diagnostic refused.';
const maximumOutputBytes = 8 * 1024 * 1024;
const launchBoundMs = 30_000;
const inputFields = Object.freeze(['status', 'signal', 'errorCode', 'stdout', 'stderr', 'durationMs', 'boundMs']);
const signals = Object.freeze([
    'SIGHUP',
    'SIGINT',
    'SIGQUIT',
    'SIGILL',
    'SIGTRAP',
    'SIGABRT',
    'SIGBUS',
    'SIGFPE',
    'SIGKILL',
    'SIGSEGV',
    'SIGPIPE',
    'SIGALRM',
    'SIGTERM',
    'SIGXCPU',
    'SIGXFSZ',
    'SIGSYS',
]);
const spawnErrors = Object.freeze([
    'ETIMEDOUT',
    'ENOENT',
    'EACCES',
    'EPERM',
    'E2BIG',
    'ENOMEM',
    'ENOBUFS',
    'EIO',
    'ENOEXEC',
    'EMFILE',
    'ENFILE',
    'EAGAIN',
]);
// Keep this exact pattern separate from, and identical to, the parent's original
// ownedLaunchPID observation. A diagnostic cannot substitute for that old gate.
const exactLaunchPID = /^app\.thalassa\.research\.scuttlebutt-auth: ([1-9][0-9]{0,8})\s*$/;

function refused() {
    throw Error(refusal);
}

function ownInput(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || types.isProxy(raw)) refused();
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) refused();
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== inputFields.length || keys.some((key) => typeof key !== 'string' || !inputFields.includes(key)))
        refused();
    const entries = [];
    for (const name of inputFields) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, name);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) refused();
        entries.push([name, descriptor.value]);
    }
    return Object.fromEntries(entries);
}

function nullableCategory(value, allowed) {
    if (value === null) return null;
    if (typeof value !== 'string') refused();
    return allowed.includes(value) ? value : 'other';
}

function outputBytes(value) {
    if (typeof value !== 'string' || value.length > maximumOutputBytes) refused();
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > maximumOutputBytes) refused();
    return bytes;
}

export function summarizeOwnedLaunchDiagnostic(raw) {
    try {
        const data = ownInput(raw);
        if (
            data.status !== null &&
            (!Number.isSafeInteger(data.status) || data.status < 0 || data.status > 255 || Object.is(data.status, -0))
        )
            refused();
        if (!Number.isSafeInteger(data.durationMs) || data.durationMs < 0 || Object.is(data.durationMs, -0)) refused();
        if (data.boundMs !== launchBoundMs) refused();
        const signal = nullableCategory(data.signal, signals);
        const spawnError = nullableCategory(data.errorCode, spawnErrors);
        const stdoutBytes = outputBytes(data.stdout);
        const stderrBytes = outputBytes(data.stderr);
        const found = exactLaunchPID.exec(data.stdout);
        // The result has no nested values or input references. It is therefore
        // deeply frozen without serializing output, supplied errors or hooks.
        return Object.freeze({
            version: 1,
            kind: 'owned-simulator-app-launch-diagnostic',
            diagnosticOnly: true,
            acceptanceEvidence: false,
            exitStatus: data.status,
            timedOut: data.errorCode === 'ETIMEDOUT',
            signal,
            spawnError,
            durationMs: data.durationMs,
            boundMs: launchBoundMs,
            exceededBound: data.durationMs > launchBoundMs,
            stdoutBytes,
            stderrBytes,
            observedPID: found ? Number(found[1]) : null,
            stdoutShape: found ? 'exact-pid' : data.stdout === '' ? 'empty' : 'other',
        });
    } catch {
        // Do not retain a hostile descriptor/proxy error, custom message, cause
        // or output. Every refused input exposes this one fixed boundary.
        return refused();
    }
}
