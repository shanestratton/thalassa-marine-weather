/** References to the SAME decoded public chart geometry, not extra storage.
 * Each borrower gets its own idempotent release. A cache drop cannot free a
 * mounted source or an asynchronous caller that still owns another reference. */
export function noaaGeometryOwner(check: () => void, dispose: () => void) {
    let refs = 1;
    const releaseOne = (): (() => void) => {
        let held = true;
        return () => {
            if (held) {
                held = false;
                if (--refs === 0) dispose();
            }
        };
    };
    const current = (): boolean => {
        if (refs === 0) return false;
        try {
            check();
            return true;
        } catch {
            return false;
        }
    };
    return {
        current,
        release: releaseOne(),
        retain: (): (() => void) => {
            if (!current()) throw Error('NOAA chart geometry is no longer current.');
            refs++;
            return releaseOne();
        },
    };
}
