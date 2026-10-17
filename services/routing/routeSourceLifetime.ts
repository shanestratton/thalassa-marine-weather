/** Process-local reader proof only; never include this callback in route metadata. */
export function assertRoutingSourceCurrent(sourceCurrent?: () => boolean): void {
    let valid = sourceCurrent === undefined;
    try {
        if (sourceCurrent !== undefined) valid = typeof sourceCurrent === 'function' && sourceCurrent() === true;
    } catch {
        valid = false;
    }
    if (!valid)
        throw Object.assign(new Error('The route’s original area sources changed before final acceptance. Replan.'), {
            code: 'exclusion-unavailable',
        });
}
