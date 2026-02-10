/**
 * Lightweight Logger Utility
 * 
 * Provides tagged, severity-aware logging for all services.
 * - Development: logs to console with module tags
 * - Production: console is stripped by esbuild (vite.config.ts drop: ['console'])
 *   Future: pipe to Sentry, Crashlytics, or in-app debug panel
 */

type LogLevel = 'info' | 'warn' | 'error';

interface Logger {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, err?: unknown, data?: unknown) => void;
}

/**
 * Create a tagged logger for a specific module.
 * 
 * Usage:
 *   const log = createLogger('ShipLog');
 *   log.info('Tracking started', { voyageId });
 *   log.error('GPS acquisition failed', error);
 */
export function createLogger(module: string): Logger {
    const tag = `[${module}]`;

    return {
        info(msg: string, data?: unknown) {
            if (data !== undefined) {
                console.log(tag, msg, data);
            } else {
                console.log(tag, msg);
            }
        },

        warn(msg: string, data?: unknown) {
            if (data !== undefined) {
                console.warn(tag, msg, data);
            } else {
                console.warn(tag, msg);
            }
        },

        error(msg: string, err?: unknown, data?: unknown) {
            if (data !== undefined) {
                console.error(tag, msg, err, data);
            } else if (err !== undefined) {
                console.error(tag, msg, err);
            } else {
                console.error(tag, msg);
            }
        },
    };
}
