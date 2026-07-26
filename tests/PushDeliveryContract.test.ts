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
        const edge = source('supabase/functions/send-push/index.ts');

        expect(edge).toContain("'apns-push-type': 'alert'");
        expect(edge).toContain("'apns-priority': '10'");
        expect(edge).not.toContain("'apns-priority': payload.isCritical ? '10' : '5'");
        expect(edge).toContain('DIRECT_MESSAGE_TTL_SECONDS = 24 * 60 * 60');
        expect(edge).toContain("case 'dm':");
        expect(edge).toContain("'apns-expiration': getApnsExpiration(");
    });

    it('keeps anchor-alarm delivery recoverable and routes its notification tap to the chart', () => {
        const edge = source('supabase/functions/send-anchor-alarm/index.ts');

        // The signing key is intentionally created inside the guarded send
        // path. A temporary secret/configuration fault must return a normal
        // failed delivery so the claimed event can be released and retried.
        const guardedDelivery = edge.slice(edge.indexOf('async function sendApnsPush'));
        expect(guardedDelivery.indexOf('try {')).toBeLessThan(guardedDelivery.indexOf('await createApnsJwt()'));
        expect(edge).toContain("notification_type: 'anchor_alarm'");
    });
});
