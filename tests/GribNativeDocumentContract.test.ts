import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const read = (path: string) => readFileSync(path, 'utf8');
describe('native GRIB document handoff boundary', () => {
    it('declares imported GRIB viewer types without exposing the app Documents directory', () => {
        const xml = new DOMParser().parseFromString(read('ios/App/App/Info.plist'), 'application/xml');
        const keys = [...xml.querySelectorAll('plist > dict > key')];
        const value = (key: string) => keys.find((node) => node.textContent === key)?.nextElementSibling;
        for (const key of ['UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace'])
            expect(value(key)?.tagName ?? 'false', key).toBe('false');
        const documents = value('CFBundleDocumentTypes');
        expect(documents?.textContent).toContain('com.thalassawx.grib');
        expect(documents?.textContent).toContain('Viewer');
        expect(documents?.textContent).toContain('Alternate');
        const types = value('UTImportedTypeDeclarations');
        expect(types?.textContent).toContain('public.data');
        expect(types?.textContent).toContain('grib1');
        expect(types?.textContent).toContain('grib2');
    });
    it('registers the bounded copy plugin in the existing native URL relay path', () => {
        const project = read('ios/App/App.xcodeproj/project.pbxproj'),
            bridge = read('ios/App/App/ThalassaBridgeViewController.swift');
        expect((project.match(/GribDocumentPlugin\.swift in Sources/g) ?? []).length).toBe(2);
        expect(bridge.includes('registerPluginInstance(GribDocumentPlugin())')).toBe(true);
        const scene = read('ios/App/App/SceneDelegate.swift');
        expect(scene.includes('SceneDelegateProxy.shared.scene')).toBe(true);
        expect(scene.includes('openURLContexts')).toBe(true);
        const copy = read('ios/App/App/GribDocumentPlugin.swift');
        expect(copy.includes('startAccessingSecurityScopedResource()')).toBe(true);
        expect(copy.includes('stopAccessingSecurityScopedResource()')).toBe(true);
        expect(copy.includes('NSFileCoordinator')).toBe(true);
        expect(copy.includes('32 * 1024 * 1024')).toBe(true);
        expect(copy.includes('read(upToCount: 65536)')).toBe(true);
    });
});
