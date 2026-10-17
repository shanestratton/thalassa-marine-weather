/** Scheduling only; no subprocess, file, permission or native operation lives here. */
const FLAG = '--shared-wait-budget-ms';
const refuse = () => {
    throw new Error('Shared build waiting refused');
};
function budget(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 120000) refuse();
    return value;
}
/** Preserve existing positional modes; only one canonical trailing option is added. */
export function parseSharedBuildWaitArgs(raw) {
    if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) refuse();
    const args = [...raw];
    let budgetMs = 120000;
    if (args.at(-2) === FLAG) {
        const value = args.pop();
        args.pop();
        if (/^(?:0|[1-9][0-9]{0,5})$/.exec(value)?.[0] !== value) refuse();
        budgetMs = budget(Number(value));
    }
    if (args.includes(FLAG)) refuse();
    return Object.freeze({ args: Object.freeze(args), budgetMs });
}

/** One cumulative ledger across all wait() calls. Clocks/processes are injected.
 * Both polling and sleeping count, including actual overshoot. Zero allowance
 * never dispatches a poll/build. persist() sees queued/failed state before throw.
 */
export function createSharedBuildWait({ budgetMs, pid, poll, sleep, now, persist }) {
    budget(budgetMs);
    if (!Number.isSafeInteger(pid) || pid <= 0 || [poll, sleep, now, persist].some((f) => typeof f !== 'function'))
        refuse();
    let spentMs = 0;
    const exhausted = new Error('Shared build slot budget exhausted');
    function record(status) {
        persist(Object.freeze({ spentMs, budgetMs, status }));
    }
    function clock() {
        const value = now();
        if (!Number.isSafeInteger(value) || value < 0) refuse();
        return value;
    }
    function elapsed(started) {
        const ended = clock();
        if (ended < started || !Number.isSafeInteger(spentMs + ended - started)) refuse();
        spentMs += ended - started;
        record('waiting');
    }
    function available() {
        if (spentMs >= budgetMs) {
            record('queued-unrun');
            throw exhausted;
        }
    }
    return Object.freeze({
        async wait() {
            try {
                for (;;) {
                    available();
                    let result;
                    const started = clock();
                    try {
                        result = poll(Math.min(10000, budgetMs - spentMs));
                    } finally {
                        elapsed(started);
                    }
                    if (result?.error || ![0, 1].includes(result?.status) || typeof result?.stdout !== 'string')
                        refuse();
                    available();
                    const others = result.stdout
                        .split('\n')
                        .filter(
                            (line) =>
                                /^\d+\s/.test(line) &&
                                !line.startsWith(pid + ' ') &&
                                !/^\d+\s+(?:\/\S*\/)?(?:sh|bash|zsh|fish|env|pgrep|xargs)(?:\s|$)/.test(line),
                        );
                    if (!others.length) {
                        record('ready');
                        return spentMs;
                    }
                    const beforeSleep = clock();
                    try {
                        await sleep(Math.min(5000, budgetMs - spentMs));
                    } finally {
                        elapsed(beforeSleep);
                    }
                }
            } catch (error) {
                if (error !== exhausted) record('failed');
                // Do not propagate raw process output/errors from injected operations.
                throw new Error(
                    error === exhausted ? 'Shared build slot budget exhausted' : 'Shared build waiting refused',
                );
            }
        },
    });
}
