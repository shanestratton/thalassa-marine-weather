/**
 * Shane 2026-08-28: "in the 'i' section, at the bottom, we should show the
 * version of thalassa on one line. so we always no what version we are on."
 *
 * He is not being fussy. Half of that day went on "the wind goes stale", and
 * the answer depended on whether his phone was running the morning's build or
 * the afternoon's — a question nothing on the screen could answer, and one I
 * had to ask him three separate times.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const panel = readFileSync('components/SystemStatusButton.tsx', 'utf8');
const links = readFileSync('services/externalLinks.ts', 'utf8');

describe('the version line', () => {
    it('is the last thing in the panel', () => {
        const tail = panel.slice(panel.indexOf('Thalassa {buildLabel'));
        expect(tail.slice(0, 400)).toContain('</div>');
        expect(panel).toContain("Thalassa {buildLabel ?? '…'}");
    });

    it('reports version, build and platform, not just a marketing version', () => {
        // "1.4.2" alone cannot tell two TestFlight builds apart, which is the
        // exact question this exists to answer.
        expect(links).toContain('`${context.appVersion} (${context.build}) · ${context.platform}`');
    });

    it('prefers what the OS says over what was bundled', () => {
        // App.getInfo() is the real installed version; the bundle stamp is the
        // fallback for web and for a native call that fails.
        expect(links).toContain('const context = await feedbackLaunchContext();');
        expect(links).toContain('await App.getInfo()');
    });

    it('does not duplicate the version logic that already existed', () => {
        // One resolver, shared with the feedback link, so the number in a bug
        // report and the number on screen can never disagree.
        expect(panel).toContain("import { appBuildLabel } from '../services/externalLinks';");
        expect(panel).not.toContain('VITE_APP_VERSION');
    });

    it('resolves once, not on every render', () => {
        expect(panel).toContain('}, []);');
        expect(panel).toContain('if (alive) setBuildLabel(label);');
    });

    it('never turns a missing version into an error in a status panel', () => {
        const block = panel.slice(panel.indexOf('void appBuildLabel()'));
        expect(block.slice(0, 400)).toContain('.catch(');
    });
});
