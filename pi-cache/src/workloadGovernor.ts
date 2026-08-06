/**
 * Process-wide admission control for work that can saturate a Raspberry Pi.
 *
 * There are deliberately only two independent lanes: chart conversion,
 * installation and download work share one lane, while inshore routing uses
 * the other. Each lane permits one active task and a tiny FIFO queue. Callers
 * must not acquire a second lease while already holding one from the same lane.
 */

export type PiWorkloadClass = 'conversion' | 'route';

export interface PiWorkloadLanePolicy {
    activeLimit: 1;
    queueLimit: number;
    retryAfterSeconds: number;
}

export const PI_WORKLOAD_BUSY_CODE = 'PI_WORKLOAD_BUSY';
export const PI_WORKLOAD_ABORTED_CODE = 'PI_WORKLOAD_ABORTED';

export const PI_WORKLOAD_POLICY: Readonly<Record<PiWorkloadClass, PiWorkloadLanePolicy>> = Object.freeze({
    conversion: Object.freeze({ activeLimit: 1, queueLimit: 2, retryAfterSeconds: 10 }),
    route: Object.freeze({ activeLimit: 1, queueLimit: 2, retryAfterSeconds: 5 }),
});

export class PiWorkloadBusyError extends Error {
    readonly status = 429;
    readonly code = PI_WORKLOAD_BUSY_CODE;

    constructor(
        readonly workloadClass: PiWorkloadClass,
        readonly retryAfterSeconds: number,
    ) {
        super(`${workloadClass} work is busy; retry shortly`);
        this.name = 'PiWorkloadBusyError';
    }
}

export class PiWorkloadAbortedError extends Error {
    readonly code = PI_WORKLOAD_ABORTED_CODE;

    constructor(readonly workloadClass: PiWorkloadClass) {
        super(`${workloadClass} work was aborted before admission`);
        this.name = 'PiWorkloadAbortedError';
    }
}

export interface PiWorkloadLease {
    readonly workloadClass: PiWorkloadClass;
    release(): void;
}

export interface PiWorkloadAdmission {
    /** True when the task consumed one of the bounded FIFO queue slots. */
    readonly queued: boolean;
    readonly lease: Promise<PiWorkloadLease>;
}

export interface PiWorkloadSubmission<T> {
    readonly queued: boolean;
    readonly completion: Promise<T>;
}

interface QueuedAdmission {
    signal?: AbortSignal;
    onAbort?: () => void;
    resolve: (lease: PiWorkloadLease) => void;
    reject: (error: Error) => void;
}

interface LaneState {
    active: number;
    queue: QueuedAdmission[];
}

export interface PiWorkloadSnapshot {
    active: number;
    queued: number;
    activeLimit: number;
    queueLimit: number;
}

export class PiWorkloadGovernor {
    private readonly lanes: Record<PiWorkloadClass, LaneState> = {
        conversion: { active: 0, queue: [] },
        route: { active: 0, queue: [] },
    };

    constructor(
        private readonly policy: Readonly<Record<PiWorkloadClass, PiWorkloadLanePolicy>> = PI_WORKLOAD_POLICY,
    ) {}

    /**
     * Reserve a lane slot. Overflow throws synchronously so an HTTP endpoint
     * can return a stable 429 before staging files or creating a job record.
     */
    admit(workloadClass: PiWorkloadClass, options: { signal?: AbortSignal } = {}): PiWorkloadAdmission {
        const lane = this.lanes[workloadClass];
        const policy = this.policy[workloadClass];
        const signal = options.signal;
        if (signal?.aborted) {
            return {
                queued: false,
                lease: Promise.reject(new PiWorkloadAbortedError(workloadClass)),
            };
        }

        if (lane.active < policy.activeLimit) {
            lane.active++;
            return { queued: false, lease: Promise.resolve(this.createLease(workloadClass)) };
        }
        if (lane.queue.length >= policy.queueLimit) {
            throw new PiWorkloadBusyError(workloadClass, policy.retryAfterSeconds);
        }

        let queued!: QueuedAdmission;
        const lease = new Promise<PiWorkloadLease>((resolve, reject) => {
            queued = { signal, resolve, reject };
        });
        if (signal) {
            queued.onAbort = () => {
                const index = lane.queue.indexOf(queued);
                if (index < 0) return;
                lane.queue.splice(index, 1);
                signal.removeEventListener('abort', queued.onAbort!);
                queued.reject(new PiWorkloadAbortedError(workloadClass));
            };
            signal.addEventListener('abort', queued.onAbort, { once: true });
        }
        lane.queue.push(queued);
        return { queued: true, lease };
    }

    /** Admit and run one task, releasing its lease on every resolution or rejection. */
    submit<T>(
        workloadClass: PiWorkloadClass,
        task: (signal?: AbortSignal) => Promise<T> | T,
        options: { signal?: AbortSignal } = {},
    ): PiWorkloadSubmission<T> {
        const admission = this.admit(workloadClass, options);
        const completion = admission.lease.then(async (lease) => {
            try {
                if (options.signal?.aborted) throw new PiWorkloadAbortedError(workloadClass);
                return await task(options.signal);
            } finally {
                lease.release();
            }
        });
        return { queued: admission.queued, completion };
    }

    snapshot(workloadClass: PiWorkloadClass): PiWorkloadSnapshot {
        const lane = this.lanes[workloadClass];
        const policy = this.policy[workloadClass];
        return {
            active: lane.active,
            queued: lane.queue.length,
            activeLimit: policy.activeLimit,
            queueLimit: policy.queueLimit,
        };
    }

    private createLease(workloadClass: PiWorkloadClass): PiWorkloadLease {
        let released = false;
        return {
            workloadClass,
            release: () => {
                if (released) return;
                released = true;
                const lane = this.lanes[workloadClass];
                lane.active = Math.max(0, lane.active - 1);
                this.drain(workloadClass);
            },
        };
    }

    private drain(workloadClass: PiWorkloadClass): void {
        const lane = this.lanes[workloadClass];
        const policy = this.policy[workloadClass];
        while (lane.active < policy.activeLimit && lane.queue.length > 0) {
            const queued = lane.queue.shift()!;
            if (queued.onAbort && queued.signal) queued.signal.removeEventListener('abort', queued.onAbort);
            if (queued.signal?.aborted) {
                queued.reject(new PiWorkloadAbortedError(workloadClass));
                continue;
            }
            lane.active++;
            queued.resolve(this.createLease(workloadClass));
        }
    }
}

export const piWorkloadGovernor = new PiWorkloadGovernor();

export function workloadBusyPayload(error: PiWorkloadBusyError): {
    error: string;
    code: typeof PI_WORKLOAD_BUSY_CODE;
    workloadClass: PiWorkloadClass;
} {
    return { error: error.message, code: PI_WORKLOAD_BUSY_CODE, workloadClass: error.workloadClass };
}
