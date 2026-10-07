/**
 * How long the remembered passage grant may paint, per account + passage,
 * between verified answers (2026-10-07 tidy-up).
 *
 * The Crew & Float Plan page paints the access it last verified while
 * getPassageStatus answers again (services/crew/lastPassageStatus), for no
 * more than 6 s. Each re-check used to start a fresh 6 s, so after a stalled
 * check had already dropped the paint, the next re-check (any change to your
 * memberships) painted the remembered, possibly revoked, grant again.
 *
 * Now the first paint for an account + passage opens one window, and it closes
 * 6 s later however many checks start meanwhile. Once it has closed with no
 * answer, or a check has answered without a grant, that grant does not paint
 * for that account + passage again until a check verifies it. Painting is all
 * a window allows: every write still waits for the verified answer.
 */

interface OpenWindow {
    kind: 'open';
    timer: ReturnType<typeof setTimeout>;
    onClose: () => void;
}
type PaintWindow = OpenWindow | { kind: 'spent' };

export interface PassagePaintWindows {
    /**
     * May the remembered grant for `key` paint now? The first call opens its
     * window and says yes; `onClose` runs when the window closes with no
     * answer. While it is open, yes again, without extending it. After it has
     * closed unverified, no, until `verified(key)`.
     */
    claim(key: string, onClose: () => void): boolean;
    /** A check verified the grant: the next check may paint it afresh. */
    verified(key: string): void;
    /** A check answered without a grant (a denial, or "no access" offline): no paint until one verifies it. */
    notGranted(key: string): void;
    /** Forget every window and stop its timer (an account switch, unmount). */
    clear(): void;
}

export function createPassagePaintWindows(paintMs: number): PassagePaintWindows {
    const windows = new Map<string, PaintWindow>();

    const stop = (key: string) => {
        const held = windows.get(key);
        if (held?.kind === 'open') clearTimeout(held.timer);
    };

    return {
        claim(key, onClose) {
            const held = windows.get(key);
            if (held?.kind === 'spent') return false;
            if (held?.kind === 'open') {
                held.onClose = onClose;
                return true;
            }
            const opened: OpenWindow = {
                kind: 'open',
                onClose,
                timer: setTimeout(() => {
                    if (windows.get(key) !== opened) return;
                    windows.set(key, { kind: 'spent' });
                    opened.onClose();
                }, paintMs),
            };
            windows.set(key, opened);
            return true;
        },
        verified(key) {
            stop(key);
            windows.delete(key);
        },
        notGranted(key) {
            stop(key);
            windows.set(key, { kind: 'spent' });
        },
        clear() {
            for (const key of windows.keys()) stop(key);
            windows.clear();
        },
    };
}
