import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('iOS push-delivery contract', () => {
    it('ships the iOS APNs entitlement for development and production builds', () => {
        const entitlements = source('ios/App/App/App.entitlements');
        const project = source('ios/App/App.xcodeproj/project.pbxproj');
        const appDelegate = source('ios/App/App/AppDelegate.swift');

        expect(entitlements).toContain('<key>aps-environment</key>');
        expect(entitlements).toContain('<string>$(APS_ENVIRONMENT)</string>');
        expect(project).toContain('APS_ENVIRONMENT = development;');
        expect(project).toContain('APS_ENVIRONMENT = production;');
        expect(appDelegate).toContain('didRegisterForRemoteNotificationsWithDeviceToken');
        expect(appDelegate).toContain('name: .capacitorDidRegisterForRemoteNotifications');
        expect(appDelegate).toContain('didFailToRegisterForRemoteNotificationsWithError');
        expect(appDelegate).toContain('name: .capacitorDidFailToRegisterForRemoteNotifications');
    });

    it('uses prompt APNs delivery for every Notification Center alert', () => {
        // The per-type settings live beside the handler since 126-04b (send-push/config.ts, deno-tested).
        const edge = source('supabase/functions/send-push/index.ts') + source('supabase/functions/send-push/config.ts');

        expect(edge).toContain("'apns-push-type': 'alert'");
        expect(edge).toContain("'apns-priority': '10'");
        expect(edge).not.toContain("'apns-priority': payload.isCritical ? '10' : '5'");
        expect(edge).toContain('DIRECT_MESSAGE_TTL_SECONDS = 24 * 60 * 60');
        expect(edge).toContain("case 'dm':");
        expect(edge).toContain("'apns-expiration': getApnsExpiration(");
    });

    it('hands each push’s data to the per-type level, expiry and stale check (official warnings, 129-06)', () => {
        // config_test.ts tests the helpers; this holds the handler to passing them the queue row's
        // data. Without it an official warning would go with the default 6 h TTL, be delivered after
        // it expired, and sound on a quiet update.
        const index = source('supabase/functions/send-push/index.ts').replace(/\s+/g, ' ');
        expect(index).toContain(
            'const aps = buildAps({ ...payload, type, level: getInterruptionLevel(type, payload.data) }, criticalAlertsEntitled);',
        );
        expect(index).toContain(
            "'apns-expiration': getApnsExpiration(type, !!payload.isCritical, Date.now(), payload.data),",
        );
        expect(index).toContain(
            'if (isStaleForDelivery(notification_type, created_at, Date.now(), data ?? undefined)) {',
        );
        // And the payload sent is that data beside aps, so a tap can read the warning it names.
        expect(index).toContain('const apnsPayload = { aps, ...payload.data };');
    });

    it('keeps anchor-alarm delivery recoverable and routes its notification tap to the chart', () => {
        const edge = source('supabase/functions/send-anchor-alarm/index.ts');

        // The signing key is intentionally created inside the guarded send
        // path. A temporary secret/configuration fault must return a normal
        // failed delivery so the claimed event can be released and retried.
        const guardedDelivery = edge.slice(edge.indexOf('async function sendApnsPush'));
        expect(guardedDelivery.indexOf('await createApnsJwt(')).toBeGreaterThanOrEqual(0);
        expect(guardedDelivery.indexOf('try {')).toBeLessThan(guardedDelivery.indexOf('await createApnsJwt('));
        expect(edge).toContain("notification_type: 'anchor_alarm'");
    });
});
