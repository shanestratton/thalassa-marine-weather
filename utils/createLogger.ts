/**
 * createLogger — the single tagged logging utility for the app.
 * ─────────────────────────────────────────────────────────────────
 * Usage:
 *   import { createLogger } from '../utils/createLogger';
 *   const log = createLogger('MyComponent');
 *   log.info('loaded', { count: 42 });   // → [MyComponent] loaded { count: 42 }
 *   log.warn('stale data');               // → [MyComponent] stale data
 *   log.error('fetch failed', err);       // → console + Sentry (if err is an Error)
 *
 * In production builds (import.meta.env.PROD):
 *   - debug() and info() are no-ops (zero cost)
 *   - warn() and error() still emit
 *
 * error() also forwards to Sentry: a breadcrumb always, and captureException
 * when an Error is passed. (Consolidated from the former utils/logger.ts so
 * there is one logger and one error-reporting path — see ROUTING_COLLAB reply
 * 62.)
 */

const IS_PROD = typeof import.meta !== 'undefined' && import.meta.env?.PROD;

// No-op for silenced levels in production
const noop = (..._args: unknown[]) => {};

export interface Logger {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

export function createLogger(tag: string): Logger {
    const prefix = `[${tag}]`;

    return {
        debug: IS_PROD ? noop : (...args: unknown[]) => console.debug(prefix, ...args),
        info: IS_PROD ? noop : (...args: unknown[]) => console.info(prefix, ...args),
        warn: (...args: unknown[]) => console.warn(prefix, ...args),
        error: (...args: unknown[]) => {
            console.error(prefix, ...args);
            // Forward to Sentry (lazy import avoids a circular dep at module init).
            try {
                const err = args.find((a) => a instanceof Error) as Error | undefined;
                const message = typeof args[0] === 'string' ? args[0] : tag;
                void import('../services/sentry')
                    .then(({ captureException, addBreadcrumb }) => {
                        addBreadcrumb({ category: tag, message, level: 'error' });
                        if (err) {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            captureException(err, { tags: { module: tag } } as any);
                        }
                    })
                    .catch(() => {
                        /* Sentry unavailable — non-critical */
                    });
            } catch {
                /* Sentry unavailable — non-critical */
            }
        },
    };
}

/**
 * Safely extract an error message from an unknown catch value.
 * Use this instead of `(err as any).message` after converting catch blocks
 * from `catch (err: any)` to `catch (err: unknown)`.
 */
export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return String(err);
}
