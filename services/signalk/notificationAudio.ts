import type { SignalKNotice, SignalKNoticeEvent } from '../../utils/signalkProtocol';
type AlarmAudio = Pick<typeof import('../AlarmAudioService').AlarmAudioService, 'acquire' | 'releaseEventually'>;
/** Session opt-in only; three-second cues own one lease and never stop another alarm owner. */
export class SignalKNotificationAudio {
    private enabled = false;
    private generation = 0;
    private pending = false;
    private pendingKey: string | null = null;
    private held: { audio: AlarmAudio; lease: string; key: string } | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(
        private readonly isCurrent: () => boolean,
        private readonly load: () => Promise<AlarmAudio> = async () =>
            (await import('../AlarmAudioService')).AlarmAudioService,
    ) {}
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) this.release();
    }
    stop(): void {
        this.enabled = false;
        this.release();
    }
    update(active: SignalKNotice[], events: SignalKNoticeEvent[]): void {
        if (
            this.pendingKey &&
            !active.some((n) => `${n.source}|${n.path}` === this.pendingKey && ['alarm', 'emergency'].includes(n.state))
        )
            this.release();
        if (
            this.held &&
            !active.some((n) => `${n.source}|${n.path}` === this.held!.key && ['alarm', 'emergency'].includes(n.state))
        )
            this.release();
        if (!this.enabled || !this.isCurrent() || this.pending || this.held) return;
        const event = events.find(
            (e) => e.fresh && e.notice.soundRequested && ['alarm', 'emergency'].includes(e.notice.state),
        );
        if (!event) return;
        const generation = this.generation,
            key = `${event.notice.source}|${event.notice.path}`;
        const fresh = () => Date.now() >= event.notice.at && Date.now() - event.notice.at <= 10_000;
        this.pending = true;
        this.pendingKey = key;
        void this.load()
            .then(async (audio) => {
                if (generation !== this.generation || !this.enabled || !this.isCurrent() || !fresh()) return;
                const lease = await audio.acquire('signalk-notification');
                if (generation !== this.generation || !this.enabled || !this.isCurrent() || !fresh()) {
                    audio.releaseEventually(lease);
                    return;
                }
                this.held = { audio, lease, key };
                this.timer = setTimeout(() => this.release(), 3000);
            })
            .catch(() => undefined)
            .finally(() => {
                if (generation === this.generation) {
                    this.pending = false;
                    this.pendingKey = null;
                }
            });
    }
    private release(): void {
        this.generation++;
        this.pending = false;
        this.pendingKey = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const held = this.held;
        this.held = null;
        held?.audio.releaseEventually(held.lease);
    }
}
