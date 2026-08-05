import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const soundCheck = read('components/anchor-watch/SoundCheckModal.tsx');
const alarmOverlay = read('components/anchor-watch/AnchorAlarmOverlay.tsx');
const anchorSetup = read('components/AnchorWatchPage.tsx');
const shoreWatch = read('components/anchor-watch/ShoreWatchModal.tsx');
const styles = read('index.css');

describe('Anchor safety controls on an 844x390 phone viewport', () => {
    it('gives Sound Check an independent scroll port and pinned safe actions', () => {
        expect(soundCheck).toContain('anchor-sound-check-dialog flex');
        expect(soundCheck).toContain('anchor-sound-check-scroll min-h-0 flex-1 overflow-y-auto');
        expect(soundCheck).toContain('anchor-sound-check-actions shrink-0');
        expect(styles).toMatch(
            /@media \(orientation: landscape\) and \(max-height: 500px\)[\s\S]*?\.anchor-sound-check-dialog[\s\S]*?max-height: 100% !important/,
        );
    });

    it('keeps Silence Alarm pinned while every alarm detail remains scroll-reachable', () => {
        expect(alarmOverlay).toContain('anchor-alarm-overlay flex min-h-0 flex-col overflow-hidden');
        expect(alarmOverlay).toContain('anchor-alarm-scroll relative z-10 flex min-h-0 flex-1');
        expect(alarmOverlay).toContain('anchor-alarm-actions relative z-10 w-full shrink-0');
        expect(styles).toMatch(
            /@media \(orientation: landscape\) and \(max-height: 500px\)[\s\S]*?\.anchor-alarm-scroll[\s\S]*?overflow-y: auto !important/,
        );
        expect(styles).toMatch(/\.anchor-alarm-actions\s*\{[\s\S]*?flex-shrink: 0 !important/);
    });

    it('keeps the complete setup and arming control scroll-reachable', () => {
        expect(anchorSetup).toContain('anchor-setup-scroll flex-1 min-h-0 flex flex-col overflow-y-auto');
        expect(anchorSetup).toContain('anchor-setup-radar flex-1');
        expect(styles).toMatch(/\.anchor-setup-scroll\s*\{[\s\S]*?padding-bottom:/);
        expect(styles).toMatch(/\.anchor-setup-radar\s*\{[\s\S]*?min-height: 180px !important/);
    });

    it('bounds Shore Watch to the viewport with scrollable keyboard-safe content', () => {
        expect(shoreWatch).toContain('anchor-shore-watch-dialog flex');
        expect(shoreWatch).toContain('min-h-0 flex-1 overflow-y-auto');
        expect(shoreWatch).toContain('min-h-11 min-w-11');
        expect(styles).toMatch(/\.anchor-shore-watch-dialog\s*\{[\s\S]*?max-height: 100% !important/);
        expect(styles).toContain("html[data-keyboard-open='true'] .anchor-shore-watch-dialog");
    });
});
