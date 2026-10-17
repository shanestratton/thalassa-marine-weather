/**
 * Chart-ahead alarms (133-04), separate from the live sounder's shoal alarm.
 * Async chart reads are bounded and epoch checked: an old route's answer can
 * never ring after Stop following. Missing charts never mean clear water.
 */
import { AlarmAudioService } from '../AlarmAudioService';
import { AnchorSafetyNotificationService } from '../AnchorSafetyNotificationService';
import { queryChartLookahead } from '../HazardQueryService';
import { aheadCone, type AheadHit } from './lookaheadRule';
import { UnderwayAlarmStore } from './underwayAlarmStore';
import { measureXte } from './underwayRule';
import type { UnderwayInputs } from './UnderwayAlarmWatch';

export interface LookaheadDependencies {
    query: typeof queryChartLookahead;
}
let epoch = 0,
    key: string | null = null,
    context: string | null = null,
    pending = false,
    lastAt = -Infinity;
let hit: AheadHit | null = null,
    acknowledged = false;
let token: string | null = null,
    wanted = false,
    alerted = false;
let effects = Promise.resolve();
const deps: LookaheadDependencies = { query: queryChartLookahead };
function sound(on: boolean): void {
    wanted = on;
    effects = effects
        .then(async () => {
            if (wanted && !token) token = await AlarmAudioService.acquire('chart-ahead-watch');
            if (!wanted && token) {
                const held = token;
                token = null;
                await AlarmAudioService.release(held).catch(() => AlarmAudioService.releaseEventually(held));
            }
            if (wanted && !alerted) {
                alerted = true;
                await AnchorSafetyNotificationService.scheduleSafetyAlert(
                    'chart-ahead',
                    'Charted danger ahead',
                    'Check the chart and the water ahead. Predicted depths are not a sounder reading.',
                );
            }
            if (!wanted && alerted) {
                alerted = false;
                await AnchorSafetyNotificationService.cancelSafetyAlert('chart-ahead');
            }
        })
        .catch(() => undefined);
}
function publish(notices: string[] = []): void {
    UnderwayAlarmStore.setLookahead(
        hit && !acknowledged
            ? {
                  kind: 'chart-ahead',
                  title: 'CHARTED DANGER AHEAD',
                  value: hit.kind === 'depth' ? 'Shallow charted water ahead' : 'Charted obstruction or land ahead',
                  detail: 'Check the chart and the water ahead',
                  note: 'Prediction along your course; keep a lookout and use the sounder.',
                  sounding: true,
                  mutedUntil: null,
              }
            : null,
        notices,
    );
    sound(hit !== null && !acknowledged);
}
export function stopChartLookahead(): void {
    epoch++;
    key = null;
    context = null;
    hit = null;
    acknowledged = false;
    lastAt = -Infinity;
    publish();
}
UnderwayAlarmStore.subscribeActions(({ kind }) => {
    if (kind === 'chart-ahead') {
        acknowledged = true;
        publish();
    }
});
/** One production pass, at most every five seconds and never overlapping. */
export async function runChartLookahead(inputs: UnderwayInputs): Promise<void> {
    const follow = inputs.following,
        fix = inputs.fix;
    if (!follow || inputs.atAnchor || inputs.sogKn === null || inputs.sogKn <= 0.5) {
        if (key !== null) stopChartLookahead();
        return;
    }
    // Snapshot the actual geometry and clearance, not just a library key or
    // array identity: either can stay the same while a route is edited.
    const nextContext = JSON.stringify([
        follow.key,
        inputs.draftM,
        inputs.marginM,
        follow.route.map((point) => [point.lat, point.lon]),
    ]);
    if (context !== nextContext) {
        stopChartLookahead();
        key = follow.key;
        context = nextContext;
    }
    if (!fix || inputs.nowMs - fix.at > 30_000 || fix.at - inputs.nowMs > 5_000 || inputs.cogDeg === null) {
        epoch++;
        publish(['Chart look-ahead: no fresh course and position']);
        return;
    }
    if (pending || inputs.nowMs - lastAt < 5_000) return;
    const measure = measureXte(follow.route, fix, { headingDeg: inputs.cogDeg });
    const cone = aheadCone(
        { ...fix, sogKn: inputs.sogKn, cogDeg: inputs.cogDeg },
        10,
        (measure?.offTrackNm ?? Infinity) <= 0.02,
    );
    if (!cone) {
        publish(['Chart look-ahead: course or speed unavailable']);
        return;
    }
    pending = true;
    lastAt = inputs.nowMs;
    const generation = epoch;
    try {
        const answer = await deps.query(cone, inputs.draftM, inputs.marginM);
        if (generation !== epoch) return;
        if (answer.hit) {
            hit = answer.hit;
            publish(answer.coverage === 'charted' ? [] : ['Chart look-ahead: chart coverage is incomplete']);
        } else if (answer.coverage === 'charted') {
            hit = null;
            acknowledged = false;
            publish();
        } else publish(['Chart look-ahead: no complete chart coverage ahead']);
    } catch {
        if (generation === epoch) publish(['Chart look-ahead unavailable; check the chart aboard']);
    } finally {
        pending = false;
    }
}
export const ChartLookaheadWatch = {
    whenIdle: () => effects,
    configureForTests(next: Partial<LookaheadDependencies>): void {
        Object.assign(deps, next);
    },
    resetForTests(): void {
        stopChartLookahead();
        pending = false;
        lastAt = -Infinity;
        deps.query = queryChartLookahead;
    },
};
