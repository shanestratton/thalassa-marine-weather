/** Synthetic evidence-contract tests only. No OS callbacks, device authority,
 * simulator, native encryption, launch or transport is exercised here. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    createResearchSceneLifecycleResource,
    inspectResearchSceneLifecycleResource,
    inspectResearchSceneLifecycleEvidence,
    requireResearchSceneProtectedRoundTrip,
} from '../experiments/scuttlebutt-e2ee/bridge-native/researchSceneLifecycleContract.mjs';

const pin = {
    runID: '12345678-1234-4234-8234-123456789abc',
    nonce: 'a'.repeat(64),
    resourceSHA256: 'b'.repeat(64),
    pid: 1234,
};
const coldAuthority = () => ({
    observationStatus: 'unavailable',
    facadeObserved: false,
    originalSnapshotObserved: false,
    accountPresent: null as boolean | null,
    originalSnapshotCurrent: null as boolean | null,
    verifyFenceCompletions: null as number | null,
});
const cover = (shown: boolean) => ({
    present: shown,
    opaque: shown,
    attachedToOwnedWindow: shown,
    coversOwnedWindowBounds: shown,
    accessibilityModal: shown,
    contentAccessibilityHidden: shown,
});
function trace() {
    const phases = [
        ['process-started', 'unattached'],
        ['application-launched', 'unattached'],
        ['scene-connected', 'foreground-inactive'],
        ['did-become-active', 'foreground-active'],
        ['protected-ready', 'foreground-active'],
        ['will-resign-active', 'foreground-inactive'],
        ['did-enter-background', 'background'],
        ['will-enter-foreground', 'foreground-inactive'],
        ['did-become-active', 'foreground-active'],
        ['foreground-ui-closed', 'foreground-active'],
    ];
    const events = phases.map(([event, activationState], index) => ({
        index,
        sequence: index + 1,
        event,
        activationState,
        cover: cover(index >= 5 && index <= 7),
        authority:
            index < 4
                ? coldAuthority()
                : {
                      observationStatus: 'observed',
                      facadeObserved: true,
                      originalSnapshotObserved: true,
                      accountPresent: index < 6,
                      originalSnapshotCurrent: index < 6,
                      verifyFenceCompletions: index < 6 ? 1 : 2,
                  },
    }));
    return {
        version: 1,
        kind: 'research-scene-lifecycle-observations',
        runID: pin.runID,
        nonce: pin.nonce,
        resourceSHA256: pin.resourceSHA256,
        process: { pid: pin.pid, epoch: '22345678-1234-4234-8234-123456789abc' },
        evidenceCategory: 'synthetic-direct-calls',
        status: 'recording',
        eventCount: events.length,
        events,
        osLifecycleProved: false,
        authorityMutated: false,
    };
}
function receipt() {
    return trace();
}

describe('scene evidence resource — synthetic bounded configuration', () => {
    it('creates an exact resource without script, store path or authority', () => {
        const resource = createResearchSceneLifecycleResource(pin.runID, pin.nonce);
        expect(resource).toEqual({
            version: 1,
            scenario: 'full-app-native-os-lifecycle-observations',
            runID: pin.runID,
            nonce: pin.nonce,
            maximumEvents: 64,
        });
        expect(Object.isFrozen(resource)).toBe(true);
        expect(inspectResearchSceneLifecycleResource(resource)).toEqual(resource);
    });
    it.each([
        { version: 4 },
        { scenario: 'full-app-native-protected-exchange' },
        { maximumEvents: 65 },
        { maximumEvents: '64' },
        { runID: '12345678-1234-4234-8234-123456789ABC' },
        { nonce: 'not-a-nonce' },
        { storePath: '/private-canary' },
        { script: 'private-canary' },
    ])('refuses wrong or expansive resource fields: %s', (mutation) => {
        expect(() =>
            inspectResearchSceneLifecycleResource({
                ...createResearchSceneLifecycleResource(pin.runID, pin.nonce),
                ...mutation,
            }),
        ).toThrow('Research scene lifecycle evidence refused');
    });
});

describe('scene evidence projection — synthetic traces, never native acceptance', () => {
    it('retains nullable unknown observations and freezes every copied layer', () => {
        const projected = inspectResearchSceneLifecycleEvidence(receipt(), pin);
        expect(projected.events[0].authority.accountPresent).toBeNull();
        expect(projected.events[0].authority.verifyFenceCompletions).toBeNull();
        expect(projected.osLifecycleProved).toBe(false);
        for (const row of [
            projected,
            projected.process,
            projected.events,
            projected.events[0],
            projected.events[0].cover,
            projected.events[0].authority,
        ])
            expect(Object.isFrozen(row)).toBe(true);
    });
    it.each([
        { version: 3 },
        { kind: 'passed-native-exchange' },
        { runID: '32345678-1234-4234-8234-123456789abc' },
        { nonce: 'c'.repeat(64) },
        { resourceSHA256: 'c'.repeat(64) },
        { evidenceCategory: 'physical-device' },
        { status: 'passed' },
        { eventCount: 0 },
        { eventCount: 65 },
        { eventCount: '10' },
        { osLifecycleProved: true },
        { authorityMutated: true },
        { error: 'private-canary' },
    ])('refuses malformed or overclaimed envelope %s', (mutation) => {
        expect(() => inspectResearchSceneLifecycleEvidence({ ...receipt(), ...mutation }, pin)).toThrow(
            'evidence refused',
        );
    });
    it.each(['runID', 'nonce', 'resourceSHA256', 'pid'])('refuses accessor pin %s without invoking it', (key) => {
        const getter = vi.fn(() => {
            throw new Error('private-canary');
        });
        const candidate = { ...pin };
        Object.defineProperty(candidate, key, { get: getter });
        expect(() => inspectResearchSceneLifecycleEvidence(receipt(), candidate)).toThrow('evidence refused');
        expect(getter).not.toHaveBeenCalled();
    });
    it.each([{ pid: 0 }, { pid: 1235 }, { pid: '1234' }, { epoch: 'invalid' }, { secret: 'private-canary' }])(
        'refuses process correlation mismatch %s',
        (mutation) => {
            const row = receipt();
            expect(() =>
                inspectResearchSceneLifecycleEvidence({ ...row, process: { ...row.process, ...mutation } }, pin),
            ).toThrow('evidence refused');
        },
    );
    it.each(['sequence', 'index', 'event', 'activationState', 'cover', 'authority'])(
        'refuses event accessor %s without invoking it',
        (key) => {
            const getter = vi.fn(() => {
                throw new Error('private-canary');
            });
            const row = receipt();
            Object.defineProperty(row.events[0], key, { get: getter });
            expect(() => inspectResearchSceneLifecycleEvidence(row, pin)).toThrow('evidence refused');
            expect(getter).not.toHaveBeenCalled();
        },
    );
    it('refuses sparse, accessor, extra-key and reordered events', () => {
        for (const mutate of [
            (row: ReturnType<typeof receipt>) => {
                delete (row.events as Array<unknown>)[1];
            },
            (row: ReturnType<typeof receipt>) => {
                Object.defineProperty(row.events, 'extra', { value: 'private-canary' });
            },
            (row: ReturnType<typeof receipt>) => {
                row.events[0].sequence = 2;
            },
            (row: ReturnType<typeof receipt>) => {
                row.events[0].event = 'scene-connected';
            },
            (row: ReturnType<typeof receipt>) => {
                row.events[4].event = 'process-started';
            },
            (row: ReturnType<typeof receipt>) => {
                row.events[4].activationState = 'synthetic-hidden';
            },
        ]) {
            const row = receipt();
            mutate(row);
            expect(() => inspectResearchSceneLifecycleEvidence(row, pin)).toThrow('evidence refused');
        }
    });
    it('refuses absent native observations disguised as false or completed fences', () => {
        for (const mutation of [
            { accountPresent: false },
            { originalSnapshotCurrent: false },
            { verifyFenceCompletions: 1 },
            { facadeObserved: true },
        ]) {
            const row = receipt();
            Object.assign(row.events[0].authority, mutation);
            expect(() => inspectResearchSceneLifecycleEvidence(row, pin)).toThrow('evidence refused');
        }
    });
    it('requires exactly bounded capacity refusal and keeps observations distinct from passes', () => {
        const row = receipt();
        row.status = 'capacity-refused';
        expect(() => inspectResearchSceneLifecycleEvidence(row, pin)).toThrow('evidence refused');
        row.events = Array.from({ length: 64 }, (_, index) => ({
            ...row.events[0],
            index,
            sequence: index + 1,
            event: index ? 'did-become-active' : 'process-started',
        }));
        row.eventCount = 64;
        expect(inspectResearchSceneLifecycleEvidence(row, pin).status).toBe('capacity-refused');
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
});

describe('future OS observation gate — populated only with synthetic test values here', () => {
    it('never upgrades synthetic direct calls into OS proof', () => {
        expect(() => requireResearchSceneProtectedRoundTrip(receipt(), pin)).toThrow('evidence refused');
    });
    it('matches a fabricated candidate sequence only with explicit further driver/UI evidence requirements', () => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        expect(requireResearchSceneProtectedRoundTrip(row, pin)).toEqual({
            status: 'observations-matched',
            pid: pin.pid,
            epoch: row.process.epoch,
            evidenceCategory: 'simulator-native-observations',
            sameProcessSceneRoundTrip: true,
            sourceBoundDriverAcceptanceRequired: true,
            protectedUiClosureReceiptRequired: true,
            physicalAcceptance: false,
            sameStoreRecoveryProved: false,
            messagingPermission: false,
        });
    });
    it.each([4, 6, 7, 8, 9])('refuses missing original snapshot observation at stage %s', (index) => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        row.events[index].authority.originalSnapshotObserved = false;
        row.events[index].authority.originalSnapshotCurrent = null;
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
    it.each([6, 7, 8, 9])(
        'does not accept expiry-only account absence without completed verify fence at stage %s',
        (index) => {
            const row = receipt();
            row.evidenceCategory = 'simulator-native-observations';
            row.events[index].authority.verifyFenceCompletions = 1;
            expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
        },
    );
    it.each(['accountPresent', 'originalSnapshotCurrent'])(
        'preserves unsafe immediate background %s rather than accepting a later stale sample',
        (key) => {
            const row = receipt();
            row.evidenceCategory = 'simulator-native-observations';
            Object.assign(row.events[6].authority, { [key]: true });
            expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
        },
    );
    it.each([
        'present',
        'opaque',
        'attachedToOwnedWindow',
        'coversOwnedWindowBounds',
        'accessibilityModal',
        'contentAccessibilityHidden',
    ])('requires observed cover property %s at inactive transition', (key) => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        Object.assign(row.events[5].cover, { [key]: false });
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
    it('refuses alternate callback order or a later second fencing operation', () => {
        const row = receipt();
        row.evidenceCategory = 'simulator-native-observations';
        row.events[7].event = 'did-enter-background';
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
        row.events[7].event = 'will-enter-foreground';
        row.events[9].authority.verifyFenceCompletions = 3;
        expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
    });
    it.each(['cover', 'account', 'snapshot', 'fence-count'])(
        'preserves protected observation at will-enter-foreground: %s',
        (mutation) => {
            const row = receipt();
            row.evidenceCategory = 'simulator-native-observations';
            const event = row.events[7];
            if (mutation === 'cover') event.cover = cover(false);
            if (mutation === 'account') event.authority.accountPresent = true;
            if (mutation === 'snapshot') event.authority.originalSnapshotCurrent = true;
            if (mutation === 'fence-count') event.authority.verifyFenceCompletions = 3;
            expect(() => requireResearchSceneProtectedRoundTrip(row, pin)).toThrow('evidence refused');
        },
    );
    it('does not wire or weaken the existing accepted native fixture/runtime', () => {
        for (const path of [
            'ResearchApp.swift',
            'ResearchAuthHost.swift',
            'ResearchLocalUiFixture.swift',
            'build.mjs',
            'generate_project.rb',
        ])
            expect(readFileSync('experiments/scuttlebutt-e2ee/bridge-native/' + path, 'utf8')).not.toContain(
                'ResearchSceneLifecycleEvidence',
            );
        expect(readFileSync('experiments/scuttlebutt-e2ee/bridge-native/ResearchAuthHost.swift', 'utf8')).toContain(
            'requireFreshInstallation(markerPresent: marker != nil, rootExists: rootExists)',
        );
    });
});
