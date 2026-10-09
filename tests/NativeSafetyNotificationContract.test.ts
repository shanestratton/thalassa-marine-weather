/**
 * The anchor's Time Sensitive notification plugin becomes the shared
 * safety-notification path (125-01 scope item 7) — with the anchor's ids,
 * sound, thread, payload, count, timing and FIFO exactly as they were.
 * An anchor-alarm regression is the worst outcome this package can have, so
 * these pin the anchor contract byte for byte and prove the new collision and
 * distress kinds can never touch it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The JS bridge, driven for real below (126-02b); the rest of this file reads sources.
const native = vi.hoisted(() => ({
    checkReadiness: vi.fn(),
    scheduleAlarm: vi.fn(),
    cancelAlarm: vi.fn(),
    scheduleSafetyAlert: vi.fn(),
    cancelSafetyAlert: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => 'ios', isNativePlatform: () => true },
    registerPlugin: () => native,
}));

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const plugin = read('ios/App/App/AnchorSafetyNotificationPlugin.swift');
const service = read('services/AnchorSafetyNotificationService.ts');

function block(source: string, start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (from < 0 || to < 0) return '';
    return source.slice(from, to);
}

describe('anchor contract unchanged', () => {
    it('keeps every anchor identifier, the legacy ids, the count and the timing', () => {
        expect(plugin).toContain('"thalassa.anchor-watch.primary"');
        expect(plugin).toContain('(0..<20).map { String(format: "thalassa.anchor-watch.repeat.%02d", $0) }');
        expect(plugin).toContain('let legacyIdentifiers = ["99001"] + (0..<20).map { String(99100 + $0) }');
        expect(plugin).toContain('private let alarmRequestCount = 21');
        expect(plugin).toContain('private let maximumPendingNotificationCount = 64');
        expect(plugin).toContain('let interval = index == 0 ? 5.0 : Double(index * 30)');
    });

    it('keeps the anchor sound, thread and payload', () => {
        expect(plugin).toContain('private static let alarmSoundName = "thalassa-anchor-alarm.wav"');
        expect(plugin).toContain('content.threadIdentifier = "thalassa.anchor-watch"');
        expect(plugin).toContain('content.userInfo = ["kind": "anchor-drag", "source": "anchor-watch"]');
    });

    it('keeps the anchor methods and their JS bridge', () => {
        for (const method of ['checkReadiness', 'scheduleAlarm', 'cancelAlarm']) {
            expect(plugin).toContain(`CAPPluginMethod(name: "${method}", returnType: CAPPluginReturnPromise)`);
        }
        expect(plugin).toContain('public let jsName = "AnchorSafetyNotifications"');
        expect(service).toContain('ANCHOR_NOTIFICATION_REQUEST_COUNT = 21');
        expect(service).toContain("registerPlugin<AnchorSafetyNotificationsPlugin>('AnchorSafetyNotifications')");
    });

    it('the anchor cleanup set still names only anchor ids', () => {
        const cleanup = block(plugin, 'private var cleanupIdentifiers: [String] {', '\n    }');
        expect(cleanup).toContain('requestIdentifiers + legacyIdentifiers');
        expect(cleanup).not.toMatch(/collision|distress|safety/i);
    });
});

describe('the shared safety path', () => {
    it('registers its own schedule/cancel methods beside the anchor ones', () => {
        expect(plugin).toContain('CAPPluginMethod(name: "scheduleSafetyAlert", returnType: CAPPluginReturnPromise)');
        expect(plugin).toContain('CAPPluginMethod(name: "cancelSafetyAlert", returnType: CAPPluginReturnPromise)');
    });

    it('has its own ids for collision and distress, distinct from the anchor', () => {
        expect(plugin).toContain('"collision": "thalassa.collision-watch"');
        expect(plugin).toContain('"distress": "thalassa.distress-watch"');
        expect(plugin).not.toMatch(/"collision": "thalassa\.anchor/);
    });

    it('is Time Sensitive behind the same verified-enabled check, never a Critical Alert', () => {
        const schedule = block(plugin, '@objc func scheduleSafetyAlert', '@objc func cancelSafetyAlert');
        expect(schedule).toContain('enqueueMutatingOperation');
        expect(schedule).toContain('withVerifiedSettings');
        const requests = block(plugin, 'private func makeSafetyAlertRequests', 'private func validatedText');
        expect(requests).toContain('content.interruptionLevel = .timeSensitive');
        expect(requests).toContain('content.threadIdentifier = prefix');
        expect(plugin).not.toContain('.critical');
    });

    it('reads back its exact set and leaves the anchor its 21 slots', () => {
        const add = block(plugin, 'private func addSafetyAlertRequests', 'private func makeSafetyAlertRequests');
        expect(add).toContain('self.maximumPendingNotificationCount - otherCount - self.safetyAlertRequestCount');
        expect(add).toContain('>= self.alarmRequestCount');
        expect(add).toContain('$0.content.interruptionLevel == .timeSensitive');
    });

    it('cleans up only its own kind', () => {
        const remove = block(
            plugin,
            'private func removeAndConfirmSafetyAlerts',
            'private func enqueueMutatingOperation',
        );
        expect(remove).toContain('safetyIdentifiers(prefix)');
        expect(remove).not.toContain('cleanupIdentifiers');
    });

    // Build 126 (126-02a): off route and shoal water ride the same path, each
    // with its own three ids. The anchor's, the collision watch's and the
    // distress alarm's are unchanged byte for byte.
    it('has its own ids for off route and shoal water, and the earlier kinds are unchanged', () => {
        const kinds = block(plugin, 'private static let safetyAlertKinds: [String: String] = [', '\n    ]');
        expect(kinds.split('\n').slice(1, 5)).toEqual([
            '        "collision": "thalassa.collision-watch",',
            '        "distress": "thalassa.distress-watch",',
            '        "off-route": "thalassa.off-route-watch",',
            '        "shoal": "thalassa.shoal-watch",',
        ]);
        expect(plugin).not.toMatch(/"(off-route|shoal)": "thalassa\.anchor/);
        expect(service).toContain("export type SafetyAlertKind = 'collision' | 'distress' | 'off-route' | 'shoal'");
        // Still three requests per kind; the 21-slot anchor reserve check is the same.
        expect(plugin).toContain('private let safetyAlertRequestCount = 3');
        expect(service).toContain('SAFETY_ALERT_REQUEST_COUNT = 3');
    });

    it('names the off-route and shoal alarms in iOS readiness messages, not Anchor Watch', () => {
        const names = block(service, 'const SAFETY_ALERT_NAMES', 'const NativeAnchorNotifications');
        expect(names).toContain('const watch = SAFETY_ALERT_NAMES[kind];');
        expect(names).toContain("'the off-route alarm'");
        expect(names).toContain("'the shoal alarm'");
        expect(names).toContain("'the collision watch'");
        expect(names).toContain("'the distress alarm'");
    });

    it('is exposed to JS with a kind and the same verification as the anchor', () => {
        expect(service).toContain("export type SafetyAlertKind = 'collision' | 'distress'");
        expect(service).toContain('SAFETY_ALERT_REQUEST_COUNT = 3');
        expect(service).toContain('NativeAnchorNotifications.scheduleSafetyAlert(request)');
        expect(service).toContain(
            'leadSeconds === undefined ? { kind, title, body } : { kind, title, body, leadSeconds }',
        );
        expect(service).toContain("result.interruptionLevel !== 'timeSensitive'");
        const safety = block(service, 'async scheduleSafetyAlert(', 'async cancelSafetyAlert(');
        expect(safety).toContain('return this.runMutation(async () =>');
    });

    // Build 126 (126-02b): the watch check books its alert minutes ahead with
    // iOS, so it fires with Thalassa suspended. Its own three ids; the lead is
    // optional, whole seconds 5...3600, and absent it is +5 s exactly as before.
    it('has its own ids for the watch check, distinct from every other kind', () => {
        const kinds = block(plugin, 'private static let safetyAlertKinds: [String: String] = [', '\n    ]');
        expect(kinds.split('\n').slice(1)).toEqual([
            '        "collision": "thalassa.collision-watch",',
            '        "distress": "thalassa.distress-watch",',
            '        "off-route": "thalassa.off-route-watch",',
            '        "shoal": "thalassa.shoal-watch",',
            '        "watch-check": "thalassa.watch-check"',
        ]);
        expect(plugin).not.toMatch(/"watch-check": "thalassa\.(anchor|collision|distress|off-route|shoal)/);
        expect(service).toContain(
            "export type SafetyAlertKind = 'collision' | 'distress' | 'off-route' | 'shoal' | 'watch-check'",
        );
        const names = block(service, 'const SAFETY_ALERT_NAMES', 'const NativeAnchorNotifications');
        expect(names).toContain("'watch-check': 'the watch check'");
        // Still three requests per kind, and the anchor keeps its 21.
        expect(plugin).toContain('private let safetyAlertRequestCount = 3');
        const add = block(plugin, 'private func addSafetyAlertRequests', 'private func makeSafetyAlertRequests');
        expect(add).toContain('>= self.alarmRequestCount');
    });

    it('reads an optional lead of whole seconds 5...3600, and rejects any other', () => {
        const schedule = block(plugin, '@objc func scheduleSafetyAlert', '@objc func cancelSafetyAlert');
        expect(schedule).toContain('call.getValue("leadSeconds") == nil');
        expect(schedule).toContain('(5...3600).contains(raw)');
        expect(schedule).toContain('raw.rounded() == raw');
        expect(schedule).toContain('"SAFETY_NOTIFICATION_INVALID_LEAD"');
        // The lead is read and checked before anything is queued or removed.
        expect(schedule.indexOf('leadSeconds')).toBeLessThan(schedule.indexOf('enqueueMutatingOperation'));
        expect(schedule).toContain('leadSeconds: leadSeconds,');
    });

    it('without a lead keeps the +5 s primary and the +30 s / +60 s reminders for every existing kind', () => {
        const requests = block(plugin, 'private func makeSafetyAlertRequests', 'private func validatedText');
        expect(requests).toContain('leadSeconds: Int?');
        expect(requests).toContain('if let leadSeconds {');
        expect(requests).toContain('interval = Double(leadSeconds + index * 30)');
        expect(requests).toContain('interval = index == 0 ? 5.0 : Double(index * 30)');
        // The anchor's own requests are untouched: no lead anywhere near them.
        const anchor = block(plugin, 'private func makeAlarmRequests', 'private func addSafetyAlertRequests');
        expect(anchor).toContain('let interval = index == 0 ? 5.0 : Double(index * 30)');
        expect(anchor).not.toContain('leadSeconds');
        const anchorSchedule = block(plugin, '@objc func scheduleAlarm', '@objc func cancelAlarm');
        expect(anchorSchedule).not.toContain('leadSeconds');
    });
});

describe('the JS bridge books a lead only when asked (126-02b)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        native.scheduleSafetyAlert.mockResolvedValue({ scheduled: 3, interruptionLevel: 'timeSensitive' });
    });

    it('without a lead, sends exactly kind, title and body for every existing kind (the +5 s primary)', async () => {
        const { AnchorSafetyNotificationService } = await import('../services/AnchorSafetyNotificationService');
        for (const kind of ['collision', 'distress', 'off-route', 'shoal'] as const) {
            await expect(AnchorSafetyNotificationService.scheduleSafetyAlert(kind, 'T', 'B')).resolves.toBe(true);
        }
        expect(native.scheduleSafetyAlert.mock.calls.map(([options]) => options)).toEqual([
            { kind: 'collision', title: 'T', body: 'B' },
            { kind: 'distress', title: 'T', body: 'B' },
            { kind: 'off-route', title: 'T', body: 'B' },
            { kind: 'shoal', title: 'T', body: 'B' },
        ]);
        for (const [options] of native.scheduleSafetyAlert.mock.calls)
            expect(options).not.toHaveProperty('leadSeconds');
    });

    it('passes a whole-second lead of 5...3600 through, and refuses any other without touching iOS', async () => {
        const { AnchorSafetyNotificationService } = await import('../services/AnchorSafetyNotificationService');
        for (const leadSeconds of [5, 900, 3600]) {
            await expect(
                AnchorSafetyNotificationService.scheduleSafetyAlert('watch-check', 'Watch check', 'B', { leadSeconds }),
            ).resolves.toBe(true);
        }
        expect(native.scheduleSafetyAlert.mock.calls.map(([options]) => options.leadSeconds)).toEqual([5, 900, 3600]);
        native.scheduleSafetyAlert.mockClear();
        for (const leadSeconds of [4, 3601, 900.5, Number.NaN, -900, Number.POSITIVE_INFINITY]) {
            await expect(
                AnchorSafetyNotificationService.scheduleSafetyAlert('watch-check', 'Watch check', 'B', { leadSeconds }),
            ).rejects.toThrow(/5 to 3,600 seconds/);
        }
        expect(native.scheduleSafetyAlert).not.toHaveBeenCalled();
        // The anchor's own bridge never carries a lead.
        expect(native.scheduleAlarm).not.toHaveBeenCalled();
    });
});
