import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Where iOS may raise its Copy / Look Up / Translate menu (Shane 2026-09-29:
 * "can we block all messages from apple that are not necessary"). The page
 * surface is unselectable; only fields and explicit opt-ins select.
 */
const css = readFileSync(resolve(__dirname, '..', 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

/** The web build keeps paragraph selection; only the iPhone app drops it. */
const WEB_ONLY = 'html:not(.native) ';

/** Every rule whose declarations switch selection or the callout back on. */
function reEnablingSelectors(): string[] {
    const found: string[] = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = match[2];
        if (/user-select:\s*(text|all|auto)|touch-callout:\s*default/.test(body)) {
            found.push(...match[1].split(',').map((s) => s.trim()));
        }
    }
    return found;
}

describe('text selection contract', () => {
    it('keeps the whole page surface unselectable with no long-press callout', () => {
        expect(css).toMatch(
            /html,\s*body\s*\{[^}]*-webkit-touch-callout:\s*none;[^}]*-webkit-user-select:\s*none;[^}]*user-select:\s*none;/,
        );
    });

    it('lets only fields and explicit opt-ins select in the iPhone app', () => {
        expect(new Set(reEnablingSelectors().filter((s) => !s.startsWith(WEB_ONLY)))).toEqual(
            new Set([
                'input',
                'textarea',
                "[contenteditable='true']",
                '.allow-text-select',
                '.select-all',
                '.select-text',
            ]),
        );
    });

    it('does not make ordinary text selectable again in the iPhone app', () => {
        const selectors = reEnablingSelectors()
            .filter((s) => !s.startsWith(WEB_ONLY))
            .join('\n');
        // The rule that made the header tagline raise Copy / Look Up.
        expect(selectors).not.toMatch(/(^|\s)p(\W|$)|article|\.prose|(^|\s)dd(\W|$)/m);
    });

    it("never overrides Tailwind's own select-all with plain text selection", () => {
        const block = css.match(/\.select-all,\s*\.select-text\s*\{([^}]*)\}/)?.[1] ?? '';
        expect(block).toMatch(/-webkit-touch-callout:\s*default/);
        expect(block).not.toMatch(/user-select/);
    });

    // The iOS menus are native-only. The web planner (/plan) is a web page,
    // and its paragraphs were selectable before the iPhone fix; they stay so.
    it('keeps paragraphs selectable on the web, and marks the iPhone app native before React renders', () => {
        const webOnly = reEnablingSelectors().filter((s) => s.startsWith(WEB_ONLY));
        expect(new Set(webOnly)).toEqual(
            new Set(['p:not(button p)', 'article', "[role='article']", '.prose', 'dd'].map((s) => WEB_ONLY + s)),
        );
        // In the same native-only block as the viewport lock, not app-wide.
        expect(source('index.tsx')).toMatch(
            /if \(Capacitor\.isNativePlatform\(\)[^)]*\) \{\s*lockNativeViewportScale\(document, window\);[^}]*document\.documentElement\.classList\.add\('native'\);\s*\}/,
        );
    });

    // A crew member posts a marina phone number, a berth code or a lat/lon; the
    // skipper long-presses to copy it. With paragraphs unselectable these are
    // opt-ins, and none of the three chat views has a Copy action of its own.
    it('keeps chat messages and the crash text copyable', () => {
        expect(source('components/chat/ChatMessageList.tsx')).toMatch(
            /<p className="[^"]*\bselect-text\b[^"]*">\s*\{msg\.message\}/,
        );
        expect(source('components/chat/ChatDMView.tsx')).toMatch(
            /<p className="[^"]*\bselect-text\b[^"]*">\s*\{message\}\s*<\/p>/,
        );
        // The isolated native pilot renders literal text without the legacy
        // content parser, so its actual paragraph needs its own selection opt-in.
        expect(source('components/chat/PrivateMessagePilotView.tsx')).toMatch(
            /<p className="[^"]*\bselect-text\b[^"]*">\s*\{dm\.message \?\? 'Message text unavailable'\}\s*<\/p>/,
        );
        expect(source('components/crew-finder/CrewListConversation.tsx')).toMatch(
            /<p className="[^"]*\bselect-text\b[^"]*">\s*\{message\.message\}/,
        );
        expect(source('components/ErrorBoundary.tsx')).toMatch(
            /<span className="[^"]*\bselect-text\b[^"]*">\s*\{error\.message\.slice\(0, 100\)\}\s*<\/span>/,
        );
    });
});
