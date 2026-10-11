// @vitest-environment node
/** Pure synthetic schemas only. No HTTPS, Auth, native, compile or device run. */
import { describe, expect, it, vi } from 'vitest';
import {
    FRESH_NATIVE_HTTPS_SWIFT_SOURCES,
    FRESH_NATIVE_HTTPS_PHASES,
    FRESH_NATIVE_HTTPS_PROOF_SOURCES,
    FRESH_NATIVE_HTTPS_ASSERTION_FIELDS,
    inspectFreshNativeHttpsStatus,
    parseFreshNativeHttpsArgs,
} from '../experiments/scuttlebutt-e2ee/relay/freshNativeHttpsContract.mjs';

const runID = '11111111-2222-3333-4444-555555555555',
    pid = 901,
    refusal = 'Fresh native HTTPS contract refused';
const prepareFields = [
    'authFixtureAssertions',
    'accountDirectoryFixtureAssertions',
    'enrollmentIntentFixtureAssertions',
    'messageAuthorityFixtureAssertions',
    'pairingHistoryFixtureAssertions',
    'scopedRelayFixtureAssertions',
    'scopedEnrollmentFixtureAssertions',
    'readinessFixtureAssertions',
    'bridgeFixtureAssertions',
];
const allFields = [
    ...prepareFields,
    'privateMessageFixtureAssertions',
    'privateAdmissionFixtureAssertions',
    'accountModeFixtureAssertions',
    'accountModeExchangeAssertions',
    'hostedPmAssertions',
];
/** An example of the native writer's flat shape, not an execution receipt. */
export function createSyntheticFreshNativeHttpsStatus(phase = 'prepare', status = 'passed') {
    const counts = Object.fromEntries(
        allFields.map((name, index) => [
            name,
            status === 'passed' &&
            ((phase === 'prepare' && prepareFields.includes(name)) ||
                (phase === 'private-messages' && name === 'privateMessageFixtureAssertions'))
                ? index + 1
                : 0,
        ]),
    );
    return {
        runID,
        phase,
        pid,
        status,
        stage: status === 'passed' ? 'complete' : 'PRIVATE-CANARY',
        physicalDeviceProtectionVerified: false,
        ...counts,
        hostedSummaryPath: '',
    };
}
type NativeStatus = ReturnType<typeof createSyntheticFreshNativeHttpsStatus>;
function inspect(raw = createSyntheticFreshNativeHttpsStatus()) {
    return inspectFreshNativeHttpsStatus(raw, runID, raw.phase, pid);
}
function refuses(change: (raw: NativeStatus) => void, phase = 'prepare') {
    const raw = createSyntheticFreshNativeHttpsStatus(phase);
    change(raw);
    expect(() => inspectFreshNativeHttpsStatus(raw, runID, phase, pid)).toThrowError(new Error(refusal));
}
const args = () => [
    '/private/tmp/thalassa-cached-provider/cache',
    '/private/tmp/thalassa-inputs/pglite-0.5.8.tgz',
    '--provider-bootstrap-receipt',
    '/private/tmp/thalassa-provider-bootstrap-fixture/provider-bootstrap-receipt.json',
];

describe('fresh local HTTPS — exact pure source and phase vocabulary', () => {
    it('pins the existing 32 experiment and two adapter Swift inputs, excluding generated bindings', () => {
        const expected = [
            'VodozemacSealedStore.swift',
            'VodozemacDmFrame.swift',
            'VodozemacDmCoordinator.swift',
            'VodozemacMessageOperations.swift',
            'VodozemacDmCoordinatorProbe.swift',
            'VodozemacEnrollmentIntentProbe.swift',
            'VodozemacRelayCodec.swift',
            'VodozemacRelayTransport.swift',
            'VodozemacSupabaseAuth.swift',
            'VodozemacAuthSession.swift',
            'VodozemacAuthProbe.swift',
            'VodozemacAccountDirectory.swift',
            'VodozemacSessionFacade.swift',
            'VodozemacAccountDirectoryProbe.swift',
            'VodozemacMessageAuthorityProbe.swift',
            'VodozemacPairingHistoryProbe.swift',
            'VodozemacScopedRelayProbe.swift',
            'VodozemacScopedEnrollmentProbe.swift',
            'VodozemacReadinessProbe.swift',
            'VodozemacResearchBridgeProbe.swift',
            'VodozemacAccountModeProbe.swift',
            'VodozemacPrivateAdmissionProbe.swift',
            'VodozemacAccountModeExchangeProbe.swift',
            'VodozemacHostedPmProbe.swift',
            'VodozemacRelayPolicy.swift',
            'VodozemacRelayResult.swift',
            'VodozemacRelayResultProbe.swift',
            'VodozemacLifecycleProbe.swift',
            'VodozemacUnresolvedProbe.swift',
            'VodozemacRelayClient.swift',
            'VodozemacScopedRelayClient.swift',
            'VodozemacExchangeProbe.swift',
            'bridge-native/ResearchMessagingAdapter.swift',
            'bridge-native/ResearchPrivateMessageAdapter.swift',
        ].map((name) => 'experiments/scuttlebutt-e2ee/' + name);
        expect(FRESH_NATIVE_HTTPS_SWIFT_SOURCES).toEqual(expected);
        expect(new Set(FRESH_NATIVE_HTTPS_SWIFT_SOURCES).size).toBe(34);
        expect(FRESH_NATIVE_HTTPS_SWIFT_SOURCES.some((name: string) => name.includes('bindings/'))).toBe(false);
        expect(Object.isFrozen(FRESH_NATIVE_HTTPS_SWIFT_SOURCES)).toBe(true);
    });
    it('retains the ten full-exchange phases without focused or hosted execution', () => {
        expect(FRESH_NATIVE_HTTPS_PHASES).toEqual([
            'tls-refuse',
            'prepare',
            'private-messages',
            'opening',
            'retry',
            'reply',
            'successor',
            'verify',
            'recovery',
            'cleanup',
        ]);
        expect(Object.isFrozen(FRESH_NATIVE_HTTPS_PHASES)).toBe(true);
        expect(FRESH_NATIVE_HTTPS_ASSERTION_FIELDS).toEqual(allFields);
        expect(Object.isFrozen(FRESH_NATIVE_HTTPS_ASSERTION_FIELDS)).toBe(true);
    });
    it('pins the prescribed proof closure without adopting the legacy runner', () => {
        expect(FRESH_NATIVE_HTTPS_PROOF_SOURCES).toEqual([
            'experiments/scuttlebutt-e2ee/relay/freshNativeHttpsProof.mjs',
            'experiments/scuttlebutt-e2ee/relay/freshNativeHttpsContract.mjs',
            'experiments/scuttlebutt-e2ee/relay/nativeExchangeServer.mjs',
            'experiments/scuttlebutt-e2ee/relay/httpGateway.ts',
            'experiments/scuttlebutt-e2ee/relay/gateway.ts',
            'experiments/scuttlebutt-e2ee/relay/signedGateway.ts',
            'experiments/scuttlebutt-e2ee/relay/signedRequest.ts',
            'experiments/scuttlebutt-e2ee/relay/supabaseAuth.ts',
            'experiments/scuttlebutt-e2ee/relay/deviceBundle.ts',
            'experiments/scuttlebutt-e2ee/relay/relay.sql',
            'experiments/scuttlebutt-e2ee/relay/pglite-pin.json',
            'experiments/scuttlebutt-e2ee/bridge-native/machOEntitlementEvidence.mjs',
            'services/chat/e2ee/directMessageEnvelope.ts',
            'services/chat/e2ee/encryptedDmDelivery.ts',
        ]);
        expect(new Set(FRESH_NATIVE_HTTPS_PROOF_SOURCES).size).toBe(14);
        expect(Object.isFrozen(FRESH_NATIVE_HTTPS_PROOF_SOURCES)).toBe(true);
    });
});

describe('fresh local HTTPS native status — synthetic observation only', () => {
    it.each([
        'prepare',
        'private-messages',
        'tls-refuse',
        'opening',
        'retry',
        'reply',
        'successor',
        'verify',
        'recovery',
        'cleanup',
    ])('copies only bound passing status and frozen counts for %s', (phase) => {
        const raw = createSyntheticFreshNativeHttpsStatus(phase),
            copied = inspect(raw);
        expect(Object.keys(copied)).toEqual(['runID', 'phase', 'pid', 'status', 'stage', 'assertionCounts']);
        expect(copied).toMatchObject({ runID, phase, pid, status: 'passed', stage: 'complete' });
        expect(Object.keys(copied.assertionCounts)).toEqual(allFields);
        expect(Object.isFrozen(copied)).toBe(true);
        expect(Object.isFrozen(copied.assertionCounts)).toBe(true);
        expect(copied).not.toHaveProperty('hostedSummaryPath');
        expect(copied).not.toHaveProperty('physicalDeviceProtectionVerified');
        const previous = copied.assertionCounts.authFixtureAssertions;
        Object.defineProperty(raw, 'authFixtureAssertions', { value: 9999, enumerable: true });
        expect(copied.assertionCounts.authFixtureAssertions).toBe(previous);
    });
    it.each(prepareFields)('requires a positive prepare fixture count %s', (name) =>
        refuses((raw) => {
            Object.defineProperty(raw, name, { value: 0, enumerable: true });
        }),
    );
    it.each(allFields.filter((name) => !prepareFields.includes(name)))(
        'rejects an unrelated positive prepare count %s',
        (name) =>
            refuses((raw) => {
                Object.defineProperty(raw, name, { value: 1, enumerable: true });
            }),
    );
    it('requires a positive private-message count', () =>
        refuses((raw) => {
            Object.defineProperty(raw, 'privateMessageFixtureAssertions', { value: 0, enumerable: true });
        }, 'private-messages'));
    it.each(allFields.filter((name) => name !== 'privateMessageFixtureAssertions'))(
        'rejects an unrelated positive private-message count %s',
        (name) =>
            refuses((raw) => {
                Object.defineProperty(raw, name, { value: 1, enumerable: true });
            }, 'private-messages'),
    );
    it.each(['tls-refuse', 'opening', 'retry', 'reply', 'successor', 'verify', 'recovery', 'cleanup'])(
        'rejects every nonzero counter outside fixture phases %s',
        (phase) => {
            for (const name of allFields)
                refuses((raw) => {
                    Object.defineProperty(raw, name, { value: 1, enumerable: true });
                }, phase);
        },
    );
    it.each(allFields)('requires the bounded counter %s', (name) => {
        refuses((raw) => {
            Reflect.deleteProperty(raw, name);
        });
        refuses((raw) => {
            Object.defineProperty(raw, name, { value: 10001, enumerable: true });
        });
    });
    it.each([-1, 1.5, NaN, Infinity, '1', true, null])('refuses a non-integer fixture count %s', (value) =>
        refuses((raw) => {
            Object.defineProperty(raw, 'authFixtureAssertions', { value, enumerable: true });
        }),
    );
    it.each(['run', 'phase', 'pid', 'status', 'stage', 'physical', 'hosted-summary'])(
        'refuses invalid native binding or permission metadata %s',
        (mode) =>
            refuses((raw) => {
                if (mode === 'run') raw.runID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
                if (mode === 'phase') raw.phase = 'opening';
                if (mode === 'pid') raw.pid = 0;
                if (mode === 'status') raw.status = 'unknown';
                if (mode === 'stage') raw.stage = 'not-complete';
                if (mode === 'physical') raw.physicalDeviceProtectionVerified = true;
                if (mode === 'hosted-summary') raw.hostedSummaryPath = '/private/tmp/raw-payload.json';
            }),
    );
    it.each(['private-admission', 'account-mode', 'account-mode-exchange', 'hosted-private-messages'])(
        'refuses unsupported focused phase %s even if the writer knows it',
        (phase) =>
            expect(() =>
                inspectFreshNativeHttpsStatus(createSyntheticFreshNativeHttpsStatus(phase), runID, phase, pid),
            ).toThrow(refusal),
    );
    it.each(['uppercase-run', 'bad-run', 'zero-pid', 'float-pid', 'oversized-pid'])(
        'refuses noncanonical caller binding %s',
        (mode) => {
            const requestedRun =
                mode === 'uppercase-run'
                    ? 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
                    : mode === 'bad-run'
                      ? 'not-a-run'
                      : runID;
            const requestedPID =
                mode === 'zero-pid' ? 0 : mode === 'float-pid' ? 1.5 : mode === 'oversized-pid' ? 1000000000 : pid;
            const raw = createSyntheticFreshNativeHttpsStatus();
            raw.runID = requestedRun;
            raw.pid = requestedPID;
            expect(() => inspectFreshNativeHttpsStatus(raw, requestedRun, 'prepare', requestedPID)).toThrow(refusal);
        },
    );
    it('refuses extras, symbols and nested values rather than copying raw data', () => {
        for (const name of ['message', Symbol('message')])
            refuses((raw) => {
                Object.defineProperty(raw, name, { value: 'PRIVATE-CANARY' });
            });
        refuses((raw) => {
            Object.defineProperty(raw, 'authFixtureAssertions', { value: { body: 'PRIVATE-CANARY' } });
        });
    });
    it('does not invoke counter or status accessors', () => {
        const getter = vi.fn(() => 'PRIVATE-CANARY');
        for (const name of ['stage', 'status', 'authFixtureAssertions'])
            refuses((raw) => {
                Object.defineProperty(raw, name, { get: getter });
            });
        expect(getter).not.toHaveBeenCalled();
    });
    it.each(['failed', 'running'])('sanitizes %s stage labels without upgrading to complete acceptance', (status) => {
        const raw = createSyntheticFreshNativeHttpsStatus('prepare', status),
            copied = inspect(raw);
        expect(copied.status).toBe(status);
        expect(copied.stage).toBe(status === 'failed' ? 'native-check-failed' : 'native-progress');
        expect(JSON.stringify(copied)).not.toContain('PRIVATE-CANARY');
        expect(Object.values(copied.assertionCounts).every((count) => count === 0)).toBe(true);
    });
    it.each(['', 'x'.repeat(257), null])('refuses an invalid raw stage size/type', (stage) => {
        const raw = createSyntheticFreshNativeHttpsStatus('prepare', 'failed');
        Object.defineProperty(raw, 'stage', { value: stage });
        expect(() => inspect(raw)).toThrow(refusal);
    });
});

describe('fresh local HTTPS CLI — pure bounded plan only', () => {
    it('copies the sole bootstrap prerequisite mode with the default budget', () => {
        const raw = args(),
            parsed = parseFreshNativeHttpsArgs(raw);
        expect(parsed).toEqual({
            cachePath: raw[0],
            archivePath: raw[1],
            bootstrapReceiptPath: raw[3],
            sharedWaitBudgetMs: 120000,
        });
        expect(Object.isFrozen(parsed)).toBe(true);
        raw[0] = '/private/tmp/changed';
        expect(parsed.cachePath).toBe('/private/tmp/thalassa-cached-provider/cache');
    });
    it.each(['0', '1', '119999', '120000'])('accepts the explicit bounded shared opportunity %s', (value) =>
        expect(parseFreshNativeHttpsArgs([...args(), '--shared-wait-budget-ms', value]).sharedWaitBudgetMs).toBe(
            Number(value),
        ),
    );
    it.each(['-1', '120001', '01', '1.5', '1e3', '+1', ' 1', '1 ', 'Infinity', 'NaN', '', '9'.repeat(128)])(
        'refuses a malformed or out-of-range shared budget %s',
        (value) =>
            expect(() => parseFreshNativeHttpsArgs([...args(), '--shared-wait-budget-ms', value])).toThrow(refusal),
    );
    it.each([
        '--account-mode-only',
        '--private-admission-only',
        '--hosted-private-messages',
        '--completed-exchange-receipt',
        '--prior-build-receipt',
        '--compile-only',
        '--simulator',
        '--recover-receipt',
    ])('refuses focused, legacy or permission flag %s', (flag) => {
        const raw = args();
        raw[2] = flag;
        expect(() => parseFreshNativeHttpsArgs(raw)).toThrow(refusal);
        expect(() => parseFreshNativeHttpsArgs([...args(), flag, 'value'])).toThrow(refusal);
    });
    it('refuses omitted, misplaced, duplicated or extra arguments', () => {
        const raw = args();
        for (const invalid of [
            raw.slice(0, 3),
            [...raw, '--shared-wait-budget-ms'],
            [raw[0], '--provider-bootstrap-receipt', raw[1], raw[3]],
            [...raw, '--provider-bootstrap-receipt', raw[3]],
            [...raw, '--shared-wait-budget-ms', '0', '--shared-wait-budget-ms', '1'],
            [...raw, '--shared-wait-budget-ms', '0', 'extra'],
        ])
            expect(() => parseFreshNativeHttpsArgs(invalid)).toThrow(refusal);
    });
    it.each([0, 1, 3])('requires canonical absolute path at argument %s', (index) => {
        for (const value of [
            'relative/path',
            'https://example.invalid/path',
            '/private/tmp/../outside',
            '/private/tmp/fixture/',
            '/private/tmp/fixture\n',
            '/private/tmp/fixture\u0000',
            'x'.repeat(1025),
        ]) {
            const raw = args();
            raw[index] = value;
            expect(() => parseFreshNativeHttpsArgs(raw)).toThrow(refusal);
        }
    });
    it('refuses array extras, sparse slots and accessors without invoking them', () => {
        const extra = args();
        Object.defineProperty(extra, 'body', { value: 'PRIVATE-CANARY' });
        expect(() => parseFreshNativeHttpsArgs(extra)).toThrow(refusal);
        const sparse = args();
        Reflect.deleteProperty(sparse, '0');
        expect(() => parseFreshNativeHttpsArgs(sparse)).toThrow(refusal);
        const getter = vi.fn(() => 'PRIVATE-CANARY'),
            access = args();
        Object.defineProperty(access, '0', { get: getter });
        expect(() => parseFreshNativeHttpsArgs(access)).toThrow(refusal);
        expect(getter).not.toHaveBeenCalled();
        const symbol = args();
        Object.defineProperty(symbol, Symbol('body'), { value: 'PRIVATE-CANARY' });
        expect(() => parseFreshNativeHttpsArgs(symbol)).toThrow(refusal);
    });
    it.each([null, {}, 'raw-command'])('refuses a non-array input with only the fixed error', (value) =>
        expect(() => parseFreshNativeHttpsArgs(value)).toThrowError(new Error(refusal)),
    );
});
