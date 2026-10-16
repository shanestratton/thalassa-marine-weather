import type { WakeConfiguration, WakeRuleStatus } from './contract.js';
import {
    wakeCloudContext,
    wakeCloudContextKey,
    wakeCloudEpisodeKey,
    WAKE_RELAY_KINDS,
    type WakeCloudAlarm,
    type WakeRelayKind,
    type WakeRelayPass,
} from './relayProtocol.js';

/** Memory-only, at most eight episodes. A restart obtains a new process context. */
export class WakeEpisodes {
    private contextKey: string | null = null;
    private alarms = new Map<WakeRelayKind, WakeCloudAlarm>();
    clear() {
        this.contextKey = null;
        this.alarms.clear();
    }
    episode(preset: WakeRuleStatus['preset']) {
        const kind = (Object.keys(WAKE_RELAY_KINDS) as WakeRelayKind[]).find((k) => WAKE_RELAY_KINDS[k] === preset)!;
        const a = this.alarms.get(kind);
        return a ? { key: a.key, raisedAt: a.raisedAt, sourceAt: a.sourceAt, ackedAt: a.ackedAt } : undefined;
    }
    pass(config: WakeConfiguration, instance: string, rows: readonly WakeRuleStatus[], now: number): WakeRelayPass {
        const context = wakeCloudContext(config, instance),
            key = wakeCloudContextKey(context);
        if (this.contextKey !== key) {
            this.clear();
            this.contextKey = key;
        }
        const states = context.rules.map((selected) => {
            const row = rows.find((r) => r.preset === WAKE_RELAY_KINDS[selected.kind]);
            if (!row?.active) this.alarms.delete(selected.kind);
            else if (
                row.status === 'active' &&
                row.lastAt !== null &&
                row.value !== null &&
                selected.sourceKey &&
                selected.threshold !== null
            ) {
                const old = this.alarms.get(selected.kind);
                if (!old || row.lastAt >= old.sourceAt)
                    this.alarms.set(selected.kind, {
                        key: old?.key ?? wakeCloudEpisodeKey(context, selected.kind, selected.sourceKey, row.lastAt),
                        sourceKey: selected.sourceKey,
                        sourceAt: row.lastAt,
                        raisedAt: old?.raisedAt ?? row.lastAt,
                        value: row.value,
                        threshold: selected.threshold,
                        depthBasis: row.depthBasis ?? null,
                        ackedAt: old?.ackedAt ?? null,
                    });
            }
            const alarm = this.alarms.get(selected.kind);
            return {
                kind: selected.kind,
                status: row?.status ?? (selected.enabled ? 'unknown' : 'disabled'),
                quiet: row?.quiet ?? false,
                alarm: alarm ? { ...alarm, value: row?.status === 'active' ? alarm.value : null } : null,
            };
        });
        return { context, evaluatedAt: now, states };
    }
    acknowledge(contextKey: string, keys: readonly string[], now: number): void {
        if (contextKey !== this.contextKey) return;
        for (const alarm of this.alarms.values()) if (keys.includes(alarm.key)) alarm.ackedAt ??= now;
    }
}
