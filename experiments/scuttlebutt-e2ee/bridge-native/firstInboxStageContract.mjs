// A diagnostic parser only. It grants no native permission, exchange success,
// lifecycle evidence or release acceptance. No missing markers are invented.
export const FIRST_INBOX_STAGE_NAMES = Object.freeze([
    'task-original-ticket',
    'adapter-operation',
    'publication-original-ticket',
    'result-publication',
    'completed',
    'failed',
]);
const fields = ['version', 'kind', 'selectedAttempts', 'markers', 'integrityRefused', 'acceptanceEvidence'];
function own(value, names) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Inbox diagnostic shape refused');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((key) => !names.includes(key)))
        throw Error('Inbox diagnostic fields refused');
    const result = {};
    for (const key of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Inbox diagnostic accessor refused');
        result[key] = descriptor.value;
    }
    return result;
}
export function inspectFirstInboxStageEvidence(value) {
    const data = own(value, fields);
    if (
        data.version !== 1 ||
        data.kind !== 'first-inbox-stage-diagnostic' ||
        ![0, 1].includes(data.selectedAttempts) ||
        data.integrityRefused !== false ||
        data.acceptanceEvidence !== false
    )
        throw Error('Inbox diagnostic classification refused');
    const markers = own(data.markers, FIRST_INBOX_STAGE_NAMES);
    if (Object.values(markers).some((count) => count !== 0 && count !== 1))
        throw Error('Inbox diagnostic counter bound refused');
    const progress = FIRST_INBOX_STAGE_NAMES.slice(0, 5);
    let prefix = 0;
    while (prefix < progress.length && markers[progress[prefix]] === 1) prefix++;
    if (progress.slice(prefix).some((stage) => markers[stage] !== 0))
        throw Error('Inbox diagnostic non-prefix refused');
    if (
        (data.selectedAttempts === 0 && (prefix !== 0 || markers.failed !== 0)) ||
        (markers.failed === 1 && (prefix < 1 || prefix > 4))
    )
        throw Error('Inbox diagnostic terminal sequence refused');
    const status =
        data.selectedAttempts === 0
            ? 'unselected'
            : markers.failed === 1
              ? 'failed'
              : prefix === 5
                ? 'completed'
                : 'pending';
    return Object.freeze({
        status,
        selectedAttempts: data.selectedAttempts,
        markers: Object.freeze(markers),
        lastStartedStage: prefix === 0 ? null : progress[prefix - 1],
        failingBoundary: markers.failed === 1 ? progress[prefix - 1] : null,
        acceptanceEvidence: false,
        javascriptConsumptionProved: false,
        nativeExecutionProvedByParser: false,
    });
}
