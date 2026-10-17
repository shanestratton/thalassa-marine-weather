/** A retained read/import wait cannot keep a retired owner or encoded file alive forever. */
export function waitForLocalChart<T>(work: Promise<T>, check: () => void, deadline: number): Promise<T> {
    let guard: (() => void) | undefined = check;
    check = () => {};
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        const finish = (error?: unknown, value?: T) => {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            guard = undefined;
            if (error !== undefined) reject(error);
            else resolve(value as T);
        };
        const verify = () => {
            try {
                guard?.();
                if (performance.now() >= deadline) throw new Error('Local chart opening timed out.');
            } catch (error) {
                finish(error);
            }
        };
        verify();
        if (!settled) timer = setInterval(verify, 50);
        work.then(
            (value) => {
                verify();
                if (!settled) finish(undefined, value);
            },
            (error) => finish(error),
        );
    });
}
