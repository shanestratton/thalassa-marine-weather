// Test-only byte-parity projection. Production driver code must not import it.
import assert from 'node:assert/strict';

const launchStartedLine =
    "    const launchStarted = receipt.lastOperation === 'owned-app-launch' ? performance.now() : null;\n";
const boundedDiagnosticBlock = `        try {
            // At most initial + foreground attempts. These detached values
            // cannot replace the original PID/failure or admit native polling.
            const diagnostics = receipt.ownedLaunchDiagnostics ?? [];
            assert(diagnostics.length < 2 && launchStarted !== null);
            const diagnostic = summarizeOwnedLaunchDiagnostic({
                status: Number.isInteger(r.status) ? r.status : null,
                signal: r.signal ?? null,
                errorCode: r.error?.code ?? null,
                stdout: r.stdout ?? '',
                stderr: r.stderr ?? '',
                durationMs: Math.ceil(performance.now() - launchStarted),
                boundMs: timeout,
            });
            receipt.ownedLaunchDiagnostics = [...diagnostics, diagnostic];
            receipt.ownedLaunchDiagnosticStatus = 'observed-unaccepted';
        } catch {
            receipt.ownedLaunchDiagnosticStatus = 'refused';
        }
`;

/** Remove precisely the two independently tested passive additions, once each.
 * Every original PID, invocation, failure, acceptance and cleanup byte remains
 * subject to the caller's unchanged full function equality assertion. */
export function withoutOwnedLaunchDiagnostic(quietFunctionBytes) {
    assert.equal(typeof quietFunctionBytes, 'string');
    assert.ok(quietFunctionBytes.startsWith('function quiet('), 'only the exact quiet() helper may be projected');
    for (const literal of [launchStartedLine, boundedDiagnosticBlock])
        assert.equal(quietFunctionBytes.split(literal).length - 1, 1, 'passive launch literal must occur exactly once');
    return quietFunctionBytes.replace(launchStartedLine, '').replace(boundedDiagnosticBlock, '');
}
