import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const anchorModel = read('ios/App/ThalassaWatch Watch App/Models/AnchorSnapshot.swift');
const anchorView = read('ios/App/ThalassaWatch Watch App/Views/AnchorWatchView.swift');
const locationManager = read('ios/App/ThalassaWatch Watch App/Services/LocationManager.swift');
const cockpitView = read('ios/App/ThalassaWatch Watch App/Views/CockpitGlanceView.swift');
const mobView = read('ios/App/ThalassaWatch Watch App/Views/MobButton.swift');
const watchSession = read('ios/App/ThalassaWatch Watch App/Services/WatchSession.swift');
const phonePlugin = read('ios/App/App/WatchConnectivityPlugin.swift');
const watchBridge = read('services/native/watchBridge.ts');
const watchListeners = read('services/native/watchBridgeListeners.ts');
const watchMobSafety = read('services/native/watchMobRequestSafety.ts');
const anchorService = read('services/AnchorWatchService.ts');
const watchInfo = read('ios/App/ThalassaWatch-Watch-App-Info.plist');
const xcodeProject = read('ios/App/App.xcodeproj/project.pbxproj');
const watchArchitecture = read('docs/apple-watch-companion.md');
const archivedPrototype = read('ios/WatchApp/README.md');

describe('Apple Watch public-beta safety honesty contract', () => {
    it('timestamps and age-gates durable Anchor context, with foreground-only local GPS', () => {
        expect(watchBridge).toMatch(/interface WatchAnchorSnapshot[\s\S]*generatedAt: number/);
        expect(anchorService).toMatch(/pushAnchorState\(\{\s*generatedAt: Date\.now\(\)/);
        expect(anchorModel).toMatch(/let generatedAt: Double/);
        expect(anchorView).toContain('snapshotFreshFor');
        expect(anchorView).toContain('ANCHOR STATUS STALE');
        expect(anchorView).toContain('Do not assume monitoring is active');
        expect(anchorView).toContain('freshDistance');
        expect(anchorView).toContain('Foreground companion only');
        expect(locationManager).toContain('while the Anchor tab is visible');
        expect(locationManager).not.toContain('alarm of last resort');
        expect(watchInfo).not.toContain('WKBackgroundModes');
        expect(xcodeProject).toContain('foreground anchor-distance check while the Anchor screen is visible');
        expect(xcodeProject).not.toContain('even when the watch face is dimmed');
    });

    it('makes Watch silence local-only and qualifies phone acknowledgement', () => {
        expect(anchorView).toContain('Silence Watch');
        expect(anchorView).toContain('phone alarm may continue');
        expect(anchorView).not.toMatch(/Text\("Silence"\)/);
        expect(watchSession).toContain('AlarmAckDeliveryState');
        expect(watchSession).toContain('phoneUnreachable');
        expect(watchSession).toMatch(/reply\["received"\]/);
    });

    it('hides stale cockpit instruments and heartbeats unchanged phone data', () => {
        expect(cockpitView).toContain('TimelineView');
        expect(cockpitView).toContain('staleAfter');
        expect(cockpitView).toContain('COCKPIT DATA STALE');
        expect(cockpitView).toContain('Old wind, HDG and SOG hidden');
        expect(cockpitView).toContain('PHONE LIVE LINK OFFLINE');
        expect(watchListeners).toContain('WEATHER_HEARTBEAT_MS');
        expect(watchListeners).toContain('WEATHER_SOURCE_MAX_AGE_MS');
        expect(watchListeners).toContain('weather._stale === true');
        expect(watchListeners).toMatch(/setInterval\([\s\S]*pushCurrentWeatherSnapshot/);
    });

    it('never describes a Watch MOB marker request as a distress transmission', () => {
        expect(mobView).toContain('Hold to mark MOB on phone');
        expect(mobView).toContain('QUEUED');
        expect(mobView).toContain('PHONE RECEIVED');
        expect(mobView).toContain('use VHF/DSC or chartplotter now');
        expect(mobView).not.toMatch(/Text\("SENT"\)/);
        expect(mobView).not.toContain('Hold to send mayday');
        expect(watchSession).toContain('MobDeliveryState');
        expect(watchSession).toContain('transferUserInfo');
        expect(watchSession).toContain('case expired');
        expect(mobView).toContain('EXPIRED');
    });

    it('retains queued MOB events only behind stable-ID, expiry, and phone dedupe gates', () => {
        expect(watchSession).toContain('UUID().uuidString.lowercased()');
        expect(watchSession).toContain('mobRequestTtlMs: Double = 15_000');
        expect(watchSession).toContain('mobRequestExpiresAtMs');
        expect(watchSession).toContain('matchingReply');
        expect(watchSession).toContain('mobUserInfoTransfer?.cancel()');
        expect(phonePlugin).toContain('retainUntilConsumed: true');
        expect(phonePlugin).toContain('didReceiveUserInfo');
        expect(phonePlugin).toContain('deliveryChannel: "queued"');
        expect(phonePlugin).toContain('reply["mobRequestId"]');
        expect(watchListeners).toContain('evaluateWatchMobRequest');
        expect(watchListeners).toContain('claimWatchMobRequest');
        expect(watchListeners).toContain('expired and was NOT marked');
        expect(watchListeners).toContain('toast.persistentError');
        expect(watchMobSafety).toContain('WATCH_MOB_REQUEST_TTL_MS = 15_000');
        expect(watchMobSafety).toContain("SEEN_REQUESTS_KEY = 'thalassa_watch_mob_requests_v1'");
        expect(watchMobSafety).toContain('Preferences.set');
    });

    it('keeps Watch documentation on the shipped foreground-only capability boundary', () => {
        expect(watchArchitecture).toContain('foreground companion');
        expect(watchArchitecture).toContain('The iPhone remains the safety authority');
        expect(watchArchitecture).toContain('no watchOS background-location mode');
        expect(watchArchitecture).not.toContain('even if the phone is locked');
        expect(watchArchitecture).not.toContain('Geofence-on-watch');
        expect(archivedPrototype).toContain('uncompiled historical prototype');
        expect(archivedPrototype).toContain('must not be added to either Xcode target');
        expect(archivedPrototype).not.toContain('Add the Swift sources to the watchOS target');
    });
});
