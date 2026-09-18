import {
    cleanupCancelledDiaryMedia,
    type DiaryMediaCleanupGateway,
    type DiaryMediaReference,
    ownedDiaryMediaPath,
} from './media-cleanup.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://project.supabase.co';

function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
    if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown): void {
    assert(
        JSON.stringify(actual) === JSON.stringify(expected),
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

async function rejects(work: () => Promise<unknown>, message: string): Promise<void> {
    try {
        await work();
    } catch (error) {
        assert(error instanceof Error && error.message.includes(message));
        return;
    }
    throw new Error(`Expected rejection: ${message}`);
}

const REFERENCES: DiaryMediaReference[] = [
    { bucket: 'diary-photos', reference: `storage:diary-photos:${OWNER}/photo.jpg` },
    {
        bucket: 'diary-audio',
        reference: `${ORIGIN}/storage/v1/object/sign/diary-audio/${OWNER}/voice%20note.m4a?token=expired`,
    },
    { bucket: 'diary-video', reference: `${ORIGIN}/storage/v1/object/public/diary-video/${OWNER}/1750000000000.mp4` },
];

class CleanupHarness implements DiaryMediaCleanupGateway {
    pending: DiaryMediaReference[];
    readonly objects = new Set<string>();
    readonly shared = new Set<string>();
    readonly removed: string[] = [];
    readonly preserved: string[] = [];
    failRemove: string | null = null;
    partialSuccess = false;
    failReferenceCheck = false;
    failCheckpoint = false;

    constructor(references = REFERENCES) {
        this.pending = structuredClone(references);
        for (const item of references) {
            const path = ownedDiaryMediaPath(item, OWNER, ORIGIN);
            if (path) this.objects.add(`${item.bucket}:${path}`);
        }
    }

    run(): Promise<void> {
        return cleanupCancelledDiaryMedia(structuredClone(this.pending), OWNER, ORIGIN, this);
    }

    isReferenced(bucket: string, path: string): Promise<boolean> {
        if (this.failReferenceCheck) throw new Error('Reference query failed');
        return Promise.resolve(this.shared.has(`${bucket}:${path}`));
    }

    remove(bucket: string, path: string): Promise<void> {
        const key = `${bucket}:${path}`;
        if (this.failRemove === key) throw new Error('Storage unavailable');
        this.removed.push(key);
        if (!this.partialSuccess) this.objects.delete(key);
        return Promise.resolve();
    }

    acknowledge(reference: DiaryMediaReference, removedPath: string | null): Promise<void> {
        if (this.failCheckpoint) throw new Error('Checkpoint unavailable');
        if (removedPath !== null && this.objects.has(`${reference.bucket}:${removedPath}`)) {
            throw new Error('Object still exists');
        }
        if (removedPath === null) this.preserved.push(reference.reference);
        this.pending = this.pending.filter((item) => JSON.stringify(item) !== JSON.stringify(reference));
        return Promise.resolve();
    }
}

Deno.test('cancellation removes exact owned photo, signed audio and legacy public video paths', async () => {
    const harness = new CleanupHarness();
    await harness.run();
    equal(harness.removed, [
        `diary-photos:${OWNER}/photo.jpg`,
        `diary-audio:${OWNER}/voice note.m4a`,
        `diary-video:${OWNER}/1750000000000.mp4`,
    ]);
    equal(harness.pending, []);
    equal(harness.objects.size, 0);
});

Deno.test('Storage failure retains the unfinished manifest after the diary row is already gone', async () => {
    const harness = new CleanupHarness();
    harness.failRemove = `diary-audio:${OWNER}/voice note.m4a`;
    await rejects(() => harness.run(), 'Storage unavailable');
    equal(harness.pending, REFERENCES.slice(1));
    equal(harness.objects.size, 2);
    harness.failRemove = null;
    await harness.run();
    equal(harness.pending, []);
    equal(harness.removed.length, 3);
    await harness.run();
    equal(harness.removed.length, 3);
});

Deno.test('lost checkpoint is retried idempotently even after Storage removed the object', async () => {
    const harness = new CleanupHarness([REFERENCES[0]]);
    harness.failCheckpoint = true;
    await rejects(() => harness.run(), 'Checkpoint unavailable');
    equal(harness.objects.size, 0);
    equal(harness.pending.length, 1);
    harness.failCheckpoint = false;
    await harness.run();
    equal(harness.pending, []);
    equal(harness.removed.length, 2);
});

Deno.test('a partial Storage success is not acknowledged while its catalog object survives', async () => {
    const harness = new CleanupHarness([REFERENCES[0]]);
    harness.partialSuccess = true;
    await rejects(() => harness.run(), 'Object still exists');
    equal(harness.pending.length, 1);
    harness.partialSuccess = false;
    await harness.run();
    equal(harness.pending, []);
});

Deno.test('a surviving diary protects shared media and failed reference reads preserve pending work', async () => {
    const harness = new CleanupHarness([REFERENCES[0]]);
    harness.failReferenceCheck = true;
    await rejects(() => harness.run(), 'Reference query failed');
    equal(harness.removed, []);
    equal(harness.pending.length, 1);
    harness.failReferenceCheck = false;
    harness.shared.add(`diary-photos:${OWNER}/photo.jpg`);
    await harness.run();
    equal(harness.removed, []);
    equal(harness.objects.size, 1);
    equal(harness.pending, []);
});

Deno.test('external, cross-owner, wrong-bucket and device-local references never authorize Storage deletion', async () => {
    const references: DiaryMediaReference[] = [
        { bucket: 'diary-video', reference: `storage:diary-video:${OTHER}/clip.mp4` },
        {
            bucket: 'diary-video',
            reference: `https://other.supabase.co/storage/v1/object/public/diary-video/${OWNER}/clip.mp4`,
        },
        { bucket: 'diary-video', reference: `${ORIGIN}/storage/v1/object/public/diary-photos/${OWNER}/photo.jpg` },
        { bucket: 'diary-video', reference: `storage:diary-video:${OWNER}-other/clip.mp4` },
        { bucket: 'diary-photos', reference: 'idb:local-photo' },
        { bucket: 'diary-audio', reference: 'data:audio/mp4;base64,aGVsbG8=' },
        { bucket: 'diary-video', reference: `storage:diary-video:${OWNER}/../${OTHER}/clip.mp4` },
        {
            bucket: 'diary-video',
            reference: `${ORIGIN}/storage/v1/object/public/diary-video/${OWNER}/%2e%2e/${OTHER}/clip.mp4`,
        },
        {
            bucket: 'diary-video',
            reference: `${ORIGIN}/storage/v1/object/public/diary-video/${OWNER}/folder/../clip.mp4`,
        },
    ];
    const harness = new CleanupHarness(references);
    await harness.run();
    equal(harness.removed, []);
    equal(harness.preserved.length, references.length);
    equal(harness.pending, []);
});

Deno.test('absent or malformed manifests fail before any deletion or checkpoint', async () => {
    for (const manifest of [undefined, null, {}, [REFERENCES[0], { bucket: 'other', reference: 'bad' }]]) {
        const harness = new CleanupHarness();
        await rejects(() => cleanupCancelledDiaryMedia(manifest, OWNER, ORIGIN, harness), 'media manifest');
        equal(harness.removed, []);
        equal(harness.pending, REFERENCES);
    }
});
