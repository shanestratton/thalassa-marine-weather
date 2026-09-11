import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '@sentry/react';

const sdk = vi.hoisted(() => ({
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    setUser: vi.fn(),
    setTag: vi.fn(),
    replayIntegration: vi.fn(),
    replayCanvasIntegration: vi.fn(),
    createReduxEnhancer: vi.fn(),
}));

vi.mock('@sentry/react', () => sdk);

const sdkApi = ['addBreadcrumb', 'captureException', 'captureMessage', 'init', 'setTag', 'setUser'];
type InitOptions = NonNullable<Parameters<(typeof import('@sentry/react'))['init']>[0]>;

describe('lazy Sentry SDK boundary', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.stubEnv('VITE_SENTRY_DSN', 'https://test-only-sentry-value.invalid/1');
        vi.stubEnv('PROD', true);
        vi.stubGlobal('__APP_BUILD__', 'test-build');
        vi.stubGlobal('__COMMIT_SHA__', 'test-commit');
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('retains only the six unchanged SDK functions, not optional integrations', async () => {
        const facade = await import('../services/sentrySdk');
        expect(Object.keys(facade).sort()).toEqual(sdkApi);
        for (const name of sdkApi) {
            expect(facade[name as keyof typeof facade]).toBe(sdk[name as keyof typeof sdk]);
        }
        expect(sdk.init).not.toHaveBeenCalled();
    });

    it('loads the narrow facade once while preserving queued crash and user operations', async () => {
        const telemetry = await import('../services/sentry');
        expect(sdk.init).not.toHaveBeenCalled();
        const error = new Error('render failed');
        const context = { tags: { boundary: 'Map' } };
        telemetry.captureException(error, context);
        telemetry.setUser({ id: 'skipper-test' });
        telemetry.setTag('screen', 'chart');
        const first = telemetry.ensureSentryLoaded();
        expect(telemetry.ensureSentryLoaded()).toBe(first);
        const loaded = await first;

        expect(Object.keys(loaded).sort()).toEqual(sdkApi);
        expect(sdk.init).toHaveBeenCalledTimes(1);
        expect(sdk.captureException).toHaveBeenCalledExactlyOnceWith(error, context);
        expect(sdk.setUser).toHaveBeenCalledExactlyOnceWith({ id: 'skipper-test' });
        expect(sdk.setTag).toHaveBeenCalledExactlyOnceWith('screen', 'chart');

        telemetry.setUser(null);
        telemetry.captureException(error);
        expect(sdk.setUser).toHaveBeenLastCalledWith(null);
        expect(sdk.captureException).toHaveBeenCalledTimes(2);
        expect(sdk.init).toHaveBeenCalledTimes(1);
    });

    it('preserves disabled replay, release metadata, privacy filters and intentional breadcrumbs', async () => {
        const telemetry = await import('../services/sentry');
        await telemetry.ensureSentryLoaded();
        const options = sdk.init.mock.calls[0][0] as InitOptions;
        expect(options).toMatchObject({
            sendDefaultPii: false,
            replaysSessionSampleRate: 0,
            replaysOnErrorSampleRate: 0,
            tracesSampleRate: 0.05,
            dist: 'test-build',
            initialScope: { tags: { commit: 'test-commit', build: 'test-build' } },
        });
        expect(options.release).toMatch(/\+test-build$/);
        expect(sdk.replayIntegration).not.toHaveBeenCalled();
        expect(sdk.replayCanvasIntegration).not.toHaveBeenCalled();

        telemetry.captureMessage('Contact skipper@example.invalid');
        telemetry.addBreadcrumb({ category: 'console', message: 'private position' });
        expect(sdk.addBreadcrumb).not.toHaveBeenCalled();
        telemetry.addBreadcrumb({ category: 'navigation', message: 'Chart opened', data: { latitude: -23.9 } });
        expect(sdk.captureMessage).toHaveBeenCalledExactlyOnceWith('Contact [redacted-email]');
        expect(sdk.addBreadcrumb).toHaveBeenCalledExactlyOnceWith({
            category: 'navigation',
            message: 'Chart opened',
            data: { latitude: '[redacted]' },
        });
        const event: ErrorEvent = {
            type: undefined,
            message: 'Contact skipper@example.invalid',
            user: { id: 'skipper-test', email: 'skipper@example.invalid' },
            extra: { latitude: -23.9 },
        };
        const filtered = await options.beforeSend?.(event, {});
        expect(filtered).toMatchObject({
            message: 'Contact [redacted-email]',
            user: { id: 'skipper-test' },
            extra: { latitude: '[redacted]' },
        });
        expect(filtered?.user).not.toHaveProperty('email');
        expect(options.beforeBreadcrumb?.({ category: 'console', message: 'private position' }, {})).toBeNull();
    });

    it('keeps wrappers inert without a DSN', async () => {
        vi.stubEnv('VITE_SENTRY_DSN', '');
        const telemetry = await import('../services/sentry');
        telemetry.captureException(new Error('local error'));
        telemetry.captureMessage('local message');
        telemetry.addBreadcrumb({ message: 'local breadcrumb' });
        telemetry.setUser({ id: 'skipper-test' });
        telemetry.setTag('screen', 'chart');
        await vi.advanceTimersByTimeAsync(20_000);
        for (const callback of Object.values(sdk)) expect(callback).not.toHaveBeenCalled();
    });

    it('keeps the SDK lazy and prevents reintroducing the complete package namespace', () => {
        const adapter = readFileSync('services/sentry.ts', 'utf8');
        const facade = readFileSync('services/sentrySdk.ts', 'utf8');
        expect(adapter).toContain("import('./sentrySdk')");
        expect(adapter).not.toContain("import('@sentry/react')");
        expect(facade).not.toMatch(/export\s+\*/);
    });
});
