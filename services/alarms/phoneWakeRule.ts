/** Evaluation only, while the phone is alive. No subscriptions/notifications yet.
 * The caller must supply approved local boat evidence, never NmeaStore's
 * legacy gauge receipt times or a cloud report's overall timestamp.
 */
export { evaluateWakeFromSignalK as evaluatePhoneWakeRule } from '../../utils/wakeRuleInputs';
export type { WakeInputContext as PhoneWakeInputContext } from '../../utils/wakeRuleInputs';
