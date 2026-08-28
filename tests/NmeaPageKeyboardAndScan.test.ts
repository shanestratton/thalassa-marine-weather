/**
 * Shane 2026-08-28, two asks on the NMEA gateway page:
 *
 *   "when i need to change the host ip or the port number when the keyboard
 *    pops up, it pushes both of those textboxes up under the heading."
 *
 *   "lets get rid of the network scan card, that is 5 parts useless."
 *
 * The keyboard half: iOS runs with KeyboardResize.None, so the web view does
 * not shrink when the keyboard opens. WebKit scrolls the focused field into
 * what it thinks is the viewport — behind the keyboard, or under the sticky
 * header. The scroller needs somewhere to scroll TO, and the field needs a
 * scroll-margin so it stops clear of the header.
 *
 * The scan half: it was written after he sailed to Tangalooma without
 * instruments because the gateway's IP had been forgotten. Real problem, poor
 * answer — it offered any open port on a known gateway number as a 'likely'
 * candidate, which is how a silent AvNav listener on the house Pi became his
 * saved gateway, and its probes could strand sockets in the YDWG's three
 * slots. The address is printed on the device and set once in a boat's life.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const page = readFileSync('components/vessel/NmeaPage.tsx', 'utf8');
const css = readFileSync('index.css', 'utf8');

describe('the keyboard no longer buries the fields', () => {
    it('gives the scroller somewhere to scroll to', () => {
        expect(css).toContain('.thalassa-keyboard-safe-page {');
        expect(css).toContain('padding-bottom: var(--thalassa-keyboard-height, 0px);');
        expect(page).toContain('className="thalassa-keyboard-safe-page flex-1 px-4 min-h-0 overflow-y-auto"');
    });

    it('stops the host and port fields clear of the sticky header', () => {
        expect(css).toContain('.thalassa-keyboard-safe-field {');
        expect(css).toContain('scroll-margin-top: 5.5rem;');
        expect(page).toContain('className="thalassa-keyboard-safe-field flex gap-2"');
    });

    it('is driven by a keyboard height something actually sets', () => {
        // Not a dangling custom property: keyboardScroll.ts writes it.
        const driver = readFileSync('utils/keyboardScroll.ts', 'utf8');
        expect(driver).toContain("setProperty('--thalassa-keyboard-height'");
    });

    it('respects reduced motion', () => {
        const block = css.slice(css.indexOf('.thalassa-keyboard-safe-page'));
        expect(block.slice(0, 600)).toContain('prefers-reduced-motion: reduce');
    });
});

describe('the scan card is gone', () => {
    it('takes the card, its state and its callbacks with it', () => {
        for (const dead of [
            'FIND IT FOR ME',
            'Don’t know the IP?',
            'startScan',
            'stopScan',
            'applyScanHit',
            'scanHits',
            'scanPhaseLabel',
        ]) {
            expect(page).not.toContain(dead);
        }
    });

    it('stops importing the scanner entirely', () => {
        // Including nativeTcpProbe, whose deadline could strand a socket in
        // one of the gateway's three slots.
        expect(page).not.toContain('gatewayScan');
        expect(page).not.toContain('nativeTcpProbe');
        expect(page).not.toContain('detectSubnetPrefix');
    });

    it('keeps the thing that made the scan unnecessary', () => {
        // The factory address as the default, and an error that names what
        // actually went wrong.
        expect(page).toContain("'192.168.1.151'");
        expect(page).toContain('<GatewayRouteNote host={host} />');
    });
});
