/**
 * Audit item 20: the app declared `remote-notification` in UIBackgroundModes
 * and both push Functions set `content-available: 1`, but AppDelegate has no
 * `didReceiveRemoteNotification:fetchCompletionHandler:` — nothing ever ran in
 * the background on a push. A declared-but-unused background mode is an App
 * Review question with no answer, so the declaration and the flag are gone.
 * Alert pushes (anchor alarm, SOS) are delivered exactly as before.
 *
 * If a real background handler is ever added, this test is the place to
 * re-declare the contract — put the handler, the mode and the flag back
 * TOGETHER.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('background push contract', () => {
    const plist = readFileSync('ios/App/App/Info.plist', 'utf8');
    const appDelegate = readFileSync('ios/App/App/AppDelegate.swift', 'utf8');
    // Comments stripped: both Functions explain in prose WHY the key is gone,
    // and prose must never trip a source contract.
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const sendPush = stripComments(readFileSync('supabase/functions/send-push/index.ts', 'utf8'));
    const anchorAlarm = stripComments(readFileSync('supabase/functions/send-anchor-alarm/index.ts', 'utf8'));

    it('does not declare a remote-notification background mode it never services', () => {
        const modes = plist.match(/<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
        expect(modes).not.toContain('remote-notification');
        // The modes that ARE used stay declared: anchor alarm audio, tracking, fetch.
        expect(modes).toContain('<string>audio</string>');
        expect(modes).toContain('<string>location</string>');
    });

    it('has no background completion handler, consistent with the declaration', () => {
        expect(appDelegate).not.toContain('fetchCompletionHandler');
    });

    it('neither push Function asks for a silent wake', () => {
        expect(sendPush).not.toContain("'content-available'");
        expect(anchorAlarm).not.toContain("'content-available'");
        // Alerts are still alerts.
        expect(sendPush).toContain('alert: { title: payload.title, body: payload.body }');
        expect(anchorAlarm).toContain("'interruption-level'");
    });
});
