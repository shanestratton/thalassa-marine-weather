/** Native-owned scene facts. They enable explicit verification only; neither a
 * descriptor nor a presentation acknowledgement is account/message authority. */
export interface ResearchNativeLifecycleDescriptor {
    readonly version: 1;
    readonly epoch: string;
    readonly phase: 'active' | 'suspended' | 'foreground-covered' | 'fence-failed';
    readonly verificationAvailable: boolean;
}
export interface ResearchClosedPresentationFacts {
    readonly logPresent: false;
    readonly composeEmpty: true;
    readonly passwordEmpty: true;
    readonly privateOpenEnabled: false;
    readonly verificationControlsDisabled: true;
}
export interface ResearchLifecycleListenerHandle {
    remove(): Promise<void> | void;
}
export interface ResearchNativeLifecycleBindings {
    lifecycleState?(): Promise<unknown>;
    acknowledgeClosedPresentation?(options: {
        epoch: string;
        domFacts: ResearchClosedPresentationFacts;
    }): Promise<unknown>;
    addListener?(
        event: 'sceneAuthorityChanged',
        listener: (descriptor: unknown) => void,
    ): Promise<ResearchLifecycleListenerHandle> | ResearchLifecycleListenerHandle;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nativeChannels = new WeakMap<object, ResearchNativeLifecycleChannel>();
interface ListenerOwner {
    deliver(raw: unknown): void;
    settle(registered: boolean): void;
}
interface ListenerSlot {
    native: ResearchNativeLifecycleBindings;
    owner: ListenerOwner | null;
    handle?: ResearchLifecycleListenerHandle;
    registering: boolean;
    removing: boolean;
    failed: boolean;
}
const listenerSlots = new WeakMap<object, ListenerSlot>();
function ensureListener(slot: ListenerSlot): void {
    if (slot.failed) {
        slot.owner?.settle(false);
        return;
    }
    if (slot.registering || slot.removing || !slot.owner) return;
    if (slot.handle) {
        slot.owner.settle(true);
        return;
    }
    slot.registering = true;
    void (async () => {
        try {
            const handle = await slot.native.addListener!('sceneAuthorityChanged', (raw) => slot.owner?.deliver(raw));
            if (!handle || typeof handle.remove !== 'function') throw new Error('Unavailable');
            slot.handle = handle;
            if (slot.owner) slot.owner.settle(true);
            else removeListener(slot);
        } catch {
            slot.failed = true;
            slot.owner?.settle(false);
        } finally {
            slot.registering = false;
        }
    })();
}
function removeListener(slot: ListenerSlot): void {
    const handle = slot.handle;
    if (!handle || slot.removing) return;
    slot.handle = undefined;
    slot.removing = true;
    void (async () => {
        try {
            await handle.remove();
        } catch {
            slot.failed = true;
            slot.owner?.settle(false);
        } finally {
            slot.removing = false;
            ensureListener(slot);
        }
    })();
}
export function getResearchNativeLifecycleChannel(
    native: ResearchNativeLifecycleBindings,
): ResearchNativeLifecycleChannel | undefined {
    return nativeChannels.get(native);
}
function sameDescriptor(
    a: ResearchNativeLifecycleDescriptor | null,
    b: ResearchNativeLifecycleDescriptor | null,
): boolean {
    return (
        a === b ||
        (!!a &&
            !!b &&
            a.epoch === b.epoch &&
            a.phase === b.phase &&
            a.verificationAvailable === b.verificationAvailable)
    );
}
function row(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const names = Reflect.ownKeys(raw);
    if (names.length !== keys.length || names.some((name) => typeof name !== 'string' || !keys.includes(name)))
        return null;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (!descriptor || !('value' in descriptor)) return null;
        output[key] = descriptor.value;
    }
    return output;
}
export function inspectResearchNativeLifecycle(raw: unknown): ResearchNativeLifecycleDescriptor | null {
    try {
        const value = row(raw, ['version', 'epoch', 'phase', 'verificationAvailable']);
        if (
            !value ||
            value.version !== 1 ||
            typeof value.epoch !== 'string' ||
            UUID.exec(value.epoch)?.[0] !== value.epoch ||
            typeof value.phase !== 'string' ||
            !['active', 'suspended', 'foreground-covered', 'fence-failed'].includes(value.phase) ||
            typeof value.verificationAvailable !== 'boolean' ||
            value.verificationAvailable !== (value.phase === 'active')
        )
            return null;
        return Object.freeze({
            version: 1,
            epoch: value.epoch,
            phase: value.phase as ResearchNativeLifecycleDescriptor['phase'],
            verificationAvailable: value.verificationAvailable,
        });
    } catch {
        return null;
    }
}
export function inspectResearchClosedPresentation(raw: unknown): ResearchClosedPresentationFacts | null {
    try {
        const value = row(raw, [
            'logPresent',
            'composeEmpty',
            'passwordEmpty',
            'privateOpenEnabled',
            'verificationControlsDisabled',
        ]);
        if (
            !value ||
            value.logPresent !== false ||
            value.composeEmpty !== true ||
            value.passwordEmpty !== true ||
            value.privateOpenEnabled !== false ||
            value.verificationControlsDisabled !== true
        )
            return null;
        return Object.freeze({
            logPresent: false,
            composeEmpty: true,
            passwordEmpty: true,
            privateOpenEnabled: false,
            verificationControlsDisabled: true,
        });
    } catch {
        return null;
    }
}

/** One current descriptor and one replay request. Events are invalidation hints,
 * never an active-state replay or an unbounded queue of retained notifications. */
export class ResearchNativeLifecycleChannel {
    readonly managed: boolean;
    private descriptor: ResearchNativeLifecycleDescriptor | null = null;
    private readonly listeners = new Set<(descriptor: ResearchNativeLifecycleDescriptor | null) => void>();
    private disposed = false;
    private revision = 0;
    private replayRequested = false;
    private registration?: Promise<boolean>;
    private handle?: ResearchLifecycleListenerHandle;
    private readInFlight?: Promise<ResearchNativeLifecycleDescriptor | null>;
    private listenerSlot?: ListenerSlot;
    private listenerOwner?: ListenerOwner;

    constructor(
        private readonly native: ResearchNativeLifecycleBindings,
        required: boolean | undefined,
        private readonly invalidate: () => void,
    ) {
        this.managed =
            required === true ||
            (required !== false &&
                (typeof native.lifecycleState === 'function' ||
                    typeof native.acknowledgeClosedPresentation === 'function'));
        nativeChannels.set(native, this);
    }
    getState(): ResearchNativeLifecycleDescriptor | null {
        return this.descriptor;
    }
    subscribe(listener: (descriptor: ResearchNativeLifecycleDescriptor | null) => void): () => void {
        this.listeners.add(listener);
        listener(this.descriptor);
        return () => this.listeners.delete(listener);
    }
    private publish(descriptor: ResearchNativeLifecycleDescriptor | null) {
        if (sameDescriptor(this.descriptor, descriptor)) return;
        this.descriptor = descriptor;
        for (const listener of this.listeners) {
            try {
                listener(descriptor);
            } catch {
                /* A renderer cannot grant authority. */
            }
        }
    }
    private close() {
        if (this.descriptor !== null) this.invalidate();
        this.publish(null);
    }
    private signal = (raw: unknown) => {
        if (this.disposed) return;
        const descriptor = inspectResearchNativeLifecycle(raw);
        this.revision += 1;
        this.replayRequested = true;
        if (
            !sameDescriptor(descriptor, this.descriptor) &&
            (!descriptor ||
                descriptor.phase !== 'active' ||
                (this.descriptor !== null && descriptor.epoch !== this.descriptor.epoch))
        )
            this.close();
        // Listener installation can synchronously deliver a signal. The initial
        // read starts only after registration and observes the latest native state.
        if (this.handle) void this.refresh();
    };
    private register(): Promise<boolean> {
        if (this.registration) return this.registration;
        this.registration = (async () => {
            try {
                if (!this.managed || this.disposed) return false;
                if (
                    typeof this.native.lifecycleState !== 'function' ||
                    typeof this.native.acknowledgeClosedPresentation !== 'function' ||
                    typeof this.native.addListener !== 'function'
                )
                    throw new Error('Unavailable');
                let slot = listenerSlots.get(this.native);
                if (!slot) {
                    slot = { native: this.native, owner: null, registering: false, removing: false, failed: false };
                    listenerSlots.set(this.native, slot);
                }
                if (slot.owner) throw new Error('Unavailable');
                this.listenerSlot = slot;
                return await new Promise<boolean>((resolve) => {
                    const owner = {
                        deliver: this.signal,
                        settle: (registered: boolean) => {
                            if (registered && !this.disposed) this.handle = slot!.handle;
                            resolve(registered && !this.disposed);
                        },
                    };
                    this.listenerOwner = owner;
                    slot!.owner = owner;
                    ensureListener(slot!);
                });
            } catch {
                if (!this.disposed) this.close();
                return false;
            }
        })();
        return this.registration;
    }
    async refresh(): Promise<ResearchNativeLifecycleDescriptor | null> {
        if (!this.managed || this.disposed || !(await this.register())) return null;
        this.replayRequested = true;
        if (this.readInFlight) return this.readInFlight;
        const reading = (async () => {
            // Coalesce bursts into one follow-up read, rather than adding a
            // promise/notification for every callback while WebKit is paused.
            for (let attempt = 0; attempt < 2 && !this.disposed && this.replayRequested; attempt += 1) {
                this.replayRequested = false;
                const ticket = this.revision;
                let descriptor: ResearchNativeLifecycleDescriptor | null;
                try {
                    descriptor = inspectResearchNativeLifecycle(await this.native.lifecycleState!());
                } catch {
                    descriptor = null;
                }
                if (this.disposed) return null;
                if (ticket !== this.revision) {
                    this.replayRequested = true;
                    continue;
                }
                const previous = this.descriptor;
                if (
                    !sameDescriptor(previous, descriptor) &&
                    (!descriptor ||
                        descriptor.phase !== 'active' ||
                        (previous !== null && previous.epoch !== descriptor.epoch))
                )
                    this.invalidate();
                this.publish(descriptor);
            }
            if (this.replayRequested) {
                // Two invalidated reads are not a current replay. Fail closed;
                // a later external signal/explicit probe may start a new bound.
                this.replayRequested = false;
                this.close();
                return null;
            }
            return this.descriptor;
        })();
        this.readInFlight = reading;
        try {
            return await reading;
        } finally {
            if (this.readInFlight === reading) this.readInFlight = undefined;
        }
    }
    async acknowledge(
        epoch: string,
        domFacts: ResearchClosedPresentationFacts,
    ): Promise<ResearchNativeLifecycleDescriptor | null> {
        const facts = inspectResearchClosedPresentation(domFacts);
        const before = await this.refresh();
        if (!facts || this.disposed || before?.epoch !== epoch || before.phase !== 'foreground-covered') return null;
        try {
            const result = inspectResearchNativeLifecycle(
                await this.native.acknowledgeClosedPresentation!({ epoch, domFacts: facts }),
            );
            if (this.disposed || result?.epoch !== epoch || result.phase !== 'active') return null;
            // The method response is not the replay channel; re-read after the
            // await so an older ACK cannot reopen a later scene generation.
            const current = await this.refresh();
            return current?.epoch === epoch && current.phase === 'active' ? current : null;
        } catch {
            if (!this.disposed) this.close();
            return null;
        }
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.revision += 1;
        this.replayRequested = false;
        if (nativeChannels.get(this.native) === this) nativeChannels.delete(this.native);
        this.handle = undefined;
        const slot = this.listenerSlot,
            owner = this.listenerOwner;
        this.listenerOwner = undefined;
        this.listenerSlot = undefined;
        if (slot && slot.owner === owner) {
            slot.owner = null;
            owner?.settle(false);
            removeListener(slot);
        }
        this.publish(null);
        this.listeners.clear();
    }
}

/** Read the committed Research DOM. Missing access controls are unknown, not a
 * manufactured closed presentation. Native separately checks the owned WebView. */
export function measureResearchClosedPresentation(root: ParentNode): ResearchClosedPresentationFacts | null {
    const password = root.querySelector<HTMLInputElement>('#pilot-password');
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
    if (buttons.length > 128) return null;
    const named = (text: string) => buttons.filter((button) => button.textContent?.trim() === text);
    const signIn = named('Sign in and verify'),
        reverify = named('Reverify'),
        logout = named('Explicit logout'),
        open = named('Check native setup and open messages');
    const compose = root.querySelector<HTMLInputElement>('input[aria-label="Message Paired sailor"]');
    if (!password || signIn.length !== 1 || reverify.length !== 1 || logout.length !== 1 || open.length !== 1)
        return null;
    return inspectResearchClosedPresentation({
        logPresent: root.querySelector('[role="log"]') !== null,
        composeEmpty: compose === null || compose.value === '',
        passwordEmpty: password.value === '',
        privateOpenEnabled: !open[0].disabled,
        verificationControlsDisabled: [signIn[0], reverify[0], logout[0]].every((button) => button.disabled),
    });
}
