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
import { describe, expect, it } from 'vitest';

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

    it('is exposed to JS with a kind and the same verification as the anchor', () => {
        expect(service).toContain("export type SafetyAlertKind = 'collision' | 'distress'");
        expect(service).toContain('SAFETY_ALERT_REQUEST_COUNT = 3');
        expect(service).toContain('NativeAnchorNotifications.scheduleSafetyAlert({ kind, title, body })');
        expect(service).toContain("result.interruptionLevel !== 'timeSensitive'");
        const safety = block(service, 'async scheduleSafetyAlert(', 'async cancelSafetyAlert(');
        expect(safety).toContain('return this.runMutation(async () =>');
    });
});
