/**
 * createLogger — Lightweight tagged logging utility
 * ─────────────────────────────────────────────────────────────────
 * Usage:
 *   import { createLogger } from '../utils/createLogger';
 *   const log = createLogger('MyComponent');
 *   log.info('loaded', { count: 42 });   // → [MyComponent] loaded { count: 42 }
 *   log.warn('stale data');               // → [MyComponent] stale data
 *
 * In production builds (import.meta.env.PROD):
 *   - debug() and info() are no-ops (zero cost)
 *   - warn() and error() still emit
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
        error: (...args: unknown[]) => console.error(prefix, ...args),
    };
}
