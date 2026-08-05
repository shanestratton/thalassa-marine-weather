import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const nativePlugin = read('ios/App/App/AnchorSafetyNotificationPlugin.swift');
const bridge = read('ios/App/App/ThalassaBridgeViewController.swift');
const xcodeProject = read('ios/App/App.xcodeproj/project.pbxproj');
const notificationService = read('services/AnchorSafetyNotificationService.ts');
const anchorService = read('services/AnchorWatchService.ts');
const bgGeo = read('services/BgGeoManager.ts');
const shipLog = read('services/ShipLogService.ts');
const infoPlist = read('ios/App/App/Info.plist');

function sourceBlock(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    if (startIndex < 0 || endIndex < 0) return '';
    return source.slice(startIndex, endIndex);
}

describe('native Anchor Watch safety-notification contract', () => {
    it('sets the real iOS Time Sensitive level and never schedules a Critical Alert', () => {
        expect(nativePlugin).toContain('import UserNotifications');
        expect(nativePlugin).toContain('content.interruptionLevel = .timeSensitive');
        expect(nativePlugin).toContain('content.sound = .default');
        expect(nativePlugin).not.toContain('content.interruptionLevel = .critical');
        expect(nativePlugin).not.toContain('UNNotificationInterruptionLevel.critical');
    });

    it('fails readiness unless authorization, alerts, sounds, and Time Sensitive settings are enabled', () => {
        expect(nativePlugin).toContain('notificationCenter.getNotificationSettings');
        expect(nativePlugin).toContain('case .authorized:');
        expect(nativePlugin).toContain('case .provisional:');
        expect(nativePlugin).toContain('ANCHOR_NOTIFICATION_PERMISSION_PROVISIONAL');
        expect(nativePlugin).toContain('settings.alertSetting == .enabled');
        expect(nativePlugin).toContain('settings.lockScreenSetting == .enabled');
        expect(nativePlugin).toContain('ANCHOR_NOTIFICATION_LOCK_SCREEN_DISABLED');
        expect(nativePlugin).toContain('settings.soundSetting == .enabled');
        expect(nativePlugin).toContain('settings.timeSensitiveSetting == .enabled');
        expect(nativePlugin).toContain('ANCHOR_NOTIFICATION_TIME_SENSITIVE_DISABLED');
    });

    it('protects the 64-request limit and reads back the exact fixed 21-request set', () => {
        expect(nativePlugin).toContain('private let maximumPendingNotificationCount = 64');
        expect(nativePlugin).toContain('private let alarmRequestCount = 21');
        expect(nativePlugin).toContain('removePendingNotificationRequests');
        expect(nativePlugin).toContain('removeDeliveredNotifications');
        expect(nativePlugin).toContain('notificationCenter.add(request) { error in');
        expect(nativePlugin).toContain('guard addErrors.isEmpty else');
        expect(nativePlugin).toContain('verifyExactScheduledSet');
        expect(nativePlugin).toContain('let exactIdentifiers = matching.count');
        expect(nativePlugin).toContain('matching.map(\\.identifier)');
        expect(nativePlugin).toContain('matching.count == self.alarmRequestCount');
        expect(nativePlugin).toContain('$0.content.interruptionLevel == .timeSensitive');
        expect(nativePlugin).toContain('99100 + $0');
        expect(nativePlugin).toContain('let interval = index == 0 ? 5.0');
    });

    it('serializes every schedule/cancel mutation through one asynchronous FIFO', () => {
        expect(nativePlugin).toContain('private var mutatingOperations: [MutatingOperation] = []');
        expect(nativePlugin).toContain('private var mutatingOperationActive = false');
        expect(nativePlugin).toContain('enqueueMutatingOperation');
        expect(nativePlugin).toContain('startNextMutatingOperationIfNeeded');
        expect(nativePlugin).not.toContain('operationGeneration');
        expect(notificationService).toContain('private mutationTail: Promise<void> = Promise.resolve()');
        expect(notificationService).toContain('return this.runMutation(async () =>');
    });

    it('is compiled, manually registered, and used by the iOS service path', () => {
        expect(bridge).toContain('registerPluginInstance(AnchorSafetyNotificationPlugin())');
        expect(xcodeProject).toMatch(/AnchorSafetyNotificationPlugin\.swift in Sources/);
        expect(notificationService).toContain(
            "registerPlugin<AnchorSafetyNotificationsPlugin>('AnchorSafetyNotifications')",
        );
        expect(notificationService).toContain('ANCHOR_NOTIFICATION_REQUEST_COUNT = 21');
        expect(notificationService).toContain("result.authorizationStatus !== 'authorized'");
        expect(notificationService).toContain('result.lockScreenEnabled !== true');
        expect(notificationService).toContain("result.interruptionLevel !== 'timeSensitive'");

        const scheduleMethod = sourceBlock(
            anchorService,
            'private async scheduleAlarmNotifications()',
            '/** Cancel every alarm-related local notification',
        );
        expect(scheduleMethod).toContain("Capacitor.getPlatform() === 'ios'");
        expect(scheduleMethod).toContain('AnchorSafetyNotificationService.scheduleAlarm(title, body)');
        expect(scheduleMethod).not.toContain("interruptionLevel: 'timeSensitive'");
        expect(anchorService).toContain('AnchorSafetyNotificationService.requireReadiness()');
        expect(anchorService).toContain('AnchorSafetyNotificationService.cancelAlarm()');
    });
});

describe('Always-location and shared marine GPS contract', () => {
    it('explicitly requests and verifies Always, then restores the shared prompt policy', () => {
        const alwaysMethod = sourceBlock(
            bgGeo,
            "async requireAlwaysLocationAuthorization(feature: 'anchor-watch' | 'voyage-log')",
            '/**\n     * Ref-counted start',
        );
        expect(alwaysMethod).toContain('current.status === AuthorizationStatus.Always');
        expect(alwaysMethod).toContain("locationAuthorizationRequest: 'Always'");
        expect(alwaysMethod).toContain('await BackgroundGeolocation.requestPermission()');
        expect(alwaysMethod).toContain('verified.status !== AuthorizationStatus.Always');
        expect(alwaysMethod).toMatch(/finally\s*\{[\s\S]*locationAuthorizationRequest: 'WhenInUse'/);
    });

    it('prevents automatic stationary pausing without conflating it with stop detection', () => {
        expect(bgGeo).toContain('pausesLocationUpdatesAutomatically: false');
        expect(bgGeo).toContain('disableStopDetection: true');
        expect(bgGeo).toContain("locationAuthorizationRequest: 'WhenInUse'");
    });

    it('requires the native Always path for Anchor Watch and active voyage logging', () => {
        expect(anchorService).toContain("requireAlwaysLocationAuthorization('anchor-watch')");
        expect(anchorService).toContain("Capacitor.getPlatform() === 'ios' && !nativeMonitoringVerified");
        expect(anchorService).toContain('A live NMEA feed is supplemental');

        const shipStart = sourceBlock(shipLog, 'async startTracking(', '// GPS engine confirmed running');
        const preflightIndex = shipStart.indexOf("requireAlwaysLocationAuthorization('voyage-log')");
        const nativeStartIndex = shipStart.indexOf('BgGeoManager.requestStart()');
        expect(preflightIndex).toBeGreaterThan(0);
        expect(nativeStartIndex).toBeGreaterThan(preflightIndex);
        expect(shipStart).not.toMatch(/this\.trackingState\s*=\s*\{[\s\S]*requireAlwaysLocationAuthorization/);
    });

    it('ships exact foreground and user-armed background purpose copy', () => {
        expect(infoPlist).toContain(
            'Thalassa uses your location while the app is open to show local marine weather, your dashboard position, navigation tools, and the anchor position you choose.',
        );
        expect(infoPlist).toContain(
            'Thalassa uses your location in the background only while you explicitly arm Anchor Watch or start voyage logging, so it can detect anchor dragging and record your passage while the screen is locked.',
        );
    });
});
