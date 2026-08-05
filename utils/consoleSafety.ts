export type SafeConsoleArgument = string | number | boolean | null | undefined;

const LOG_LINE_BREAKS = /[\r\n\u2028\u2029]/g;

function singleLine(value: string, maxLength: number): string {
    return value.replace(LOG_LINE_BREAKS, ' ').slice(0, maxLength);
}

/**
 * Convert untrusted diagnostics to one bounded log line. Objects are reduced
 * to fixed metadata so custom stringifiers cannot inject text or disclose
 * user content through the global browser-console bridge.
 */
export function safeConsoleArgument(value: unknown): SafeConsoleArgument {
    if (typeof value === 'string') return singleLine(value, 2_000);
    if (value instanceof Error) {
        const name = singleLine(value.name, 80);
        const message = singleLine(value.message, 1_900);
        return `[${name || 'Error'}] ${message}`;
    }
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) return `[array:${value.length}]`;
    return '[structured value omitted]';
}
