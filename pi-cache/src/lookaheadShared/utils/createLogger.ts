// GENERATED vault logger: no app runtime or network imports.
export function createLogger(_tag: string) {
    return {
        debug: (..._args: unknown[]) => {},
        info: (..._args: unknown[]) => {},
        warn: (...args: unknown[]) => console.warn(...args),
        error: (...args: unknown[]) => console.error(...args),
    };
}
