// @vitest-environment node
/**
 * STATIC Swift source contracts only; Swift/UIKit are not executed here.
 * These checks provide no UIKit callback-ordering, app-switcher/device screenshot,
 * instrumentation, compilation or runtime privacy evidence.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(
    new URL('../experiments/scuttlebutt-e2ee/bridge-native/ResearchApp.swift', import.meta.url),
    'utf8',
);

/** Extract one declaration/branch by balanced braces, rather than matching its entire body. */
function swiftBlock(input: string, declaration: RegExp): string {
    const found = declaration.exec(input);
    if (!found) throw new Error('Expected static Swift declaration is missing');
    const open = input.indexOf('{', found.index + found[0].length);
    if (open < 0) throw new Error('Expected static Swift declaration has no body');
    let depth = 1;
    for (let index = open + 1; index < input.length; index += 1) {
        if (input[index] === '{') depth += 1;
        if (input[index] === '}') depth -= 1;
        if (depth === 0) return input.slice(open + 1, index);
    }
    throw new Error('Static Swift declaration has unbalanced braces');
}
const scene = () => swiftBlock(source, /final\s+class\s+ResearchSceneDelegate\b/);
const method = (name: string) => swiftBlock(scene(), new RegExp(`\\bfunc\\s+${name}\\s*\\(`));
const compact = (value: string) => value.replace(/\s+/g, '');

describe('research scene privacy cover — static source contract, not runtime proof', () => {
    it('declares one cover and calls it synchronously from both inactive callbacks', () => {
        expect(scene()).toMatch(/private\s+var\s+privacyCover\s*:\s*UIView\?/);
        for (const name of ['sceneWillResignActive', 'sceneDidEnterBackground']) {
            const body = method(name);
            expect(body).toContain('showPrivacyCover()');
            expect(body).not.toContain('hidePrivacyCover()');
            expect(body).not.toMatch(/\b(?:Task|DispatchQueue|async|await)\b/);
        }
        expect(method('sceneDidBecomeActive')).toContain('hidePrivacyCover()');
        // Definition plus the active callback: no inactive/other caller removes it.
        expect(scene().match(/\bhidePrivacyCover\s*\(/g)).toHaveLength(2);
    });
    it('creates or raises an opaque full-window cover with fixed nonsensitive modal accessibility', () => {
        const body = method('showPrivacyCover');
        const code = compact(body);
        expect(code).toContain('window.endEditing(true)');
        expect(code).toContain('UIView(frame:window.bounds)');
        expect(code).toContain('.flexibleWidth');
        expect(code).toContain('.flexibleHeight');
        expect(code).toContain('alpha:1)');
        expect(code).toContain('.isOpaque=true');
        expect(body).toMatch(/\.backgroundColor\s*=/);
        expect(body).not.toMatch(/\.backgroundColor\s*=\s*(?:UIColor\.)?\.?(?:clear)\b/);
        expect(code).toContain('.accessibilityViewIsModal=true');
        expect(code).toContain('.isUserInteractionEnabled=true');
        expect(code).toContain('.isAccessibilityElement=true');
        expect(body).toContain('"Private message test hidden"');
        expect(code).toContain('window.addSubview(');
        expect(code).toContain('window.bringSubviewToFront(');
        expect(code).toContain('window.layoutIfNeeded()');
        expect(body).toMatch(/privacyCover\s*=\s*\w+/);
        const existing = swiftBlock(body, /\bif\s+let\s+(?:privacyCover|\w+\s*=\s*privacyCover)\s*(?=\{)/);
        expect(compact(existing)).toContain('cover=existing');
        expect(compact(existing)).toContain('cover.frame=window.bounds');
        expect(existing).not.toContain('UIView(');
        expect(body.match(/UIView\s*\(\s*frame\s*:/g)).toHaveLength(1);
        expect(body).not.toMatch(/\b(?:Task|DispatchQueue|async|await)\b/);
    });
    it('hides underlying accessibility and restores its saved value when the cover is removed', () => {
        const show = method('showPrivacyCover');
        const hide = method('hidePrivacyCover');
        const saved = /\b(\w+)\s*=\s*[^\n=]*\.accessibilityElementsHidden\b/.exec(show);
        expect(saved, 'the previous root accessibility state must be saved').not.toBeNull();
        if (!saved) throw new Error('Saved accessibility state missing from static source');
        expect(compact(show)).toContain('ifcoveredContentView==nil');
        expect(show).toMatch(/\.accessibilityElementsHidden\s*=\s*true\b/);
        expect(show.indexOf(saved[0])).toBeLessThan(show.search(/\.accessibilityElementsHidden\s*=\s*true\b/));
        const alias = new RegExp(`\\bif\\s+let\\s+(\\w+)\\s*=\\s*${saved[1]}\\b`).exec(hide);
        expect(hide).toMatch(new RegExp(`\\.accessibilityElementsHidden\\s*=\\s*${alias?.[1] ?? saved[1]}\\b`));
        expect(hide).not.toMatch(/\.accessibilityElementsHidden\s*=\s*(?:true|false)\b/);
        expect(compact(hide)).toContain('privacyCover?.removeFromSuperview()');
        expect(compact(hide)).toContain('privacyCover=nil');
        expect(compact(hide)).toContain(`${saved[1]}=nil`);
    });
    it('keeps the cover helpers free of capture, WebView, storage and Auth operations', () => {
        const helpers = `${method('showPrivacyCover')}\n${method('hidePrivacyCover')}`;
        expect(helpers).not.toMatch(
            /\b(?:snapshotView|resizableSnapshotView|takeSnapshot|drawHierarchy|UIGraphicsImageRenderer|UIImage|WKWebView|evaluateJavaScript|FileManager|UserDefaults|fenceSession|authenticate|signOut|sign_out|accessToken|privateMessageSendText)\b/,
        );
        expect(helpers).not.toMatch(/\.write\s*\(/);
        expect(helpers).not.toContain('registerPluginInstance');
    });
    it('preserves the external-scene role guard and one shared research bridge registration', () => {
        const connecting = method('scene');
        const code = compact(connecting);
        expect(code).toContain('guardsession.role==.windowApplication');
        expect(code.indexOf('.windowApplication')).toBeLessThan(code.indexOf('UIWindow(windowScene:'));
        expect(code).toContain('window.rootViewController=ResearchBridgeViewController()');
        expect(source.match(/ResearchBridgeViewController\(\)/g)).toHaveLength(1);
        expect(source.match(/registerPluginInstance\(ScuttlebuttResearchAuthPlugin\(\)\)/g)).toHaveLength(1);
    });
});
