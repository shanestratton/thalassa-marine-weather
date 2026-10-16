/** Evaluation adapter only. Update 7's owned runner/relay is not installed by
 * adding this module; callers must never claim a Pi keeper on this basis.
 */
export { evaluateWakeFromSignalK as evaluatePiWakeRule } from './wakeRule/wakeRuleInputs.js';
export type { WakeInputContext as PiWakeInputContext } from './wakeRule/wakeRuleInputs.js';
