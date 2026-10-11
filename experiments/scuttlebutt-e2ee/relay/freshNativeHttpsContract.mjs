/** Pure local-HTTPS runner inputs and sanitized native status. No execution,
 * transport permission, provider provenance or release acceptance is granted. */
import { isAbsolute, resolve } from 'node:path';

const prefix = 'experiments/scuttlebutt-e2ee/';
export const FRESH_NATIVE_HTTPS_SWIFT_SOURCES = Object.freeze([
    ...[
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
    ].map((name) => prefix + name),
    prefix + 'bridge-native/ResearchMessagingAdapter.swift',
    prefix + 'bridge-native/ResearchPrivateMessageAdapter.swift',
]);
export const FRESH_NATIVE_HTTPS_PHASES = Object.freeze([
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
export const FRESH_NATIVE_HTTPS_PROOF_SOURCES = Object.freeze([
    ...[
        'relay/freshNativeHttpsProof.mjs',
        'relay/freshNativeHttpsContract.mjs',
        'relay/nativeExchangeServer.mjs',
        'relay/httpGateway.ts',
        'relay/gateway.ts',
        'relay/signedGateway.ts',
        'relay/signedRequest.ts',
        'relay/supabaseAuth.ts',
        'relay/deviceBundle.ts',
        'relay/relay.sql',
        'relay/pglite-pin.json',
        'bridge-native/machOEntitlementEvidence.mjs',
    ].map((name) => prefix + name),
    'services/chat/e2ee/directMessageEnvelope.ts',
    'services/chat/e2ee/encryptedDmDelivery.ts',
]);
export const FRESH_NATIVE_HTTPS_ASSERTION_FIELDS = Object.freeze([
    'authFixtureAssertions',
    'accountDirectoryFixtureAssertions',
    'enrollmentIntentFixtureAssertions',
    'messageAuthorityFixtureAssertions',
    'pairingHistoryFixtureAssertions',
    'scopedRelayFixtureAssertions',
    'scopedEnrollmentFixtureAssertions',
    'readinessFixtureAssertions',
    'bridgeFixtureAssertions',
    'privateMessageFixtureAssertions',
    'privateAdmissionFixtureAssertions',
    'accountModeFixtureAssertions',
    'accountModeExchangeAssertions',
    'hostedPmAssertions',
]);
const STATUS_FIELDS = Object.freeze([
    'runID',
    'phase',
    'status',
    'stage',
    'pid',
    'physicalDeviceProtectionVerified',
    ...FRESH_NATIVE_HTTPS_ASSERTION_FIELDS,
    'hostedSummaryPath',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFUSAL = 'Fresh native HTTPS contract refused';
function requireEvidence(value) {
    if (!value) throw new Error(REFUSAL);
}
function guarded(action) {
    try {
        return action();
    } catch {
        throw new Error(REFUSAL);
    }
}
function data(value, name) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    requireEvidence(descriptor && Object.hasOwn(descriptor, 'value'));
    return descriptor.value;
}
function exact(value, names) {
    requireEvidence(value !== null && typeof value === 'object' && !Array.isArray(value));
    const keys = Reflect.ownKeys(value);
    requireEvidence(
        keys.length === names.length && keys.every((name) => typeof name === 'string' && names.includes(name)),
    );
    return Object.fromEntries(names.map((name) => [name, data(value, name)]));
}
function integer(value, min, max) {
    requireEvidence(Number.isSafeInteger(value) && value >= min && value <= max);
    return value;
}
function uuid(value) {
    return typeof value === 'string' && value.length === 36 && UUID.test(value);
}
function absolutePath(value) {
    requireEvidence(
        typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 1024 &&
            isAbsolute(value) &&
            resolve(value) === value,
    );
    requireEvidence(
        !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
    );
    return value;
}

/** Only the exact fields written by ExchangeArguments.status are inspected.
 * A passed native status is one phase observation, not whole-run acceptance. */
export function inspectFreshNativeHttpsStatus(raw, runID, phase, pid) {
    return guarded(() => {
        requireEvidence(uuid(runID) && FRESH_NATIVE_HTTPS_PHASES.includes(phase));
        integer(pid, 1, 999999999);
        const value = exact(raw, STATUS_FIELDS);
        requireEvidence(value.runID === runID && value.phase === phase && value.pid === pid);
        requireEvidence(value.physicalDeviceProtectionVerified === false && value.hostedSummaryPath === '');
        requireEvidence(['running', 'failed', 'passed'].includes(value.status));
        requireEvidence(typeof value.stage === 'string' && value.stage.length > 0 && value.stage.length <= 256);
        const counts = Object.fromEntries(
            FRESH_NATIVE_HTTPS_ASSERTION_FIELDS.map((name) => [name, integer(value[name], 0, 10000)]),
        );
        if (value.status === 'passed') {
            requireEvidence(value.stage === 'complete');
            const positive =
                phase === 'prepare'
                    ? FRESH_NATIVE_HTTPS_ASSERTION_FIELDS.slice(0, 9)
                    : phase === 'private-messages'
                      ? ['privateMessageFixtureAssertions']
                      : [];
            for (const name of FRESH_NATIVE_HTTPS_ASSERTION_FIELDS)
                requireEvidence(positive.includes(name) ? counts[name] > 0 : counts[name] === 0);
        }
        return Object.freeze({
            runID,
            phase,
            pid,
            status: value.status,
            stage:
                value.status === 'passed'
                    ? 'complete'
                    : value.status === 'failed'
                      ? 'native-check-failed'
                      : 'native-progress',
            assertionCounts: Object.freeze(counts),
        });
    });
}

/** No focused/hosted/legacy receipt modes or caller-selected permissions.
 * The driver must independently validate actual files, hashes and ownership. */
export function parseFreshNativeHttpsArgs(argv) {
    return guarded(() => {
        requireEvidence(Array.isArray(argv));
        const length = data(argv, 'length');
        requireEvidence(length === 4 || length === 6);
        const names = ['length', ...Array.from({ length }, (_, index) => String(index))];
        const keys = Reflect.ownKeys(argv);
        requireEvidence(
            keys.length === names.length && keys.every((name) => typeof name === 'string' && names.includes(name)),
        );
        const args = Array.from({ length }, (_, index) => data(argv, String(index)));
        requireEvidence(args[2] === '--provider-bootstrap-receipt');
        let sharedWaitBudgetMs = 120000;
        if (length === 6) {
            requireEvidence(args[4] === '--shared-wait-budget-ms');
            requireEvidence(typeof args[5] === 'string' && /^(?:0|[1-9][0-9]{0,5})$/.test(args[5]));
            sharedWaitBudgetMs = integer(Number(args[5]), 0, 120000);
        }
        return Object.freeze({
            cachePath: absolutePath(args[0]),
            archivePath: absolutePath(args[1]),
            bootstrapReceiptPath: absolutePath(args[3]),
            sharedWaitBudgetMs,
        });
    });
}
