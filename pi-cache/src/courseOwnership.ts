import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validCourseOwnership, type CourseOwnershipStore, type OwnedCourse } from './courseWriter.js';
const MAX_BYTES = 16_384;
/** One Pi's private navigation receipts. Corruption is a refusal, never permission to invent ownership. */
export class CourseOwnershipFile implements CourseOwnershipStore {
    private readonly file: string;
    constructor(
        private readonly root: string,
        private readonly piId: string,
    ) {
        if (!piId || piId.length > 128 || /\p{Cc}/u.test(piId)) throw Error('Invalid Pi identity.');
        this.file = path.join(root, 'course-ownership-v1.json');
    }
    read(): OwnedCourse[] {
        let info: fs.Stats;
        try {
            info = fs.lstatSync(this.file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
            throw Error('Course ownership storage needs review.');
        const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!value || typeof value !== 'object') throw Error('Invalid course ownership.');
        const record = value as { schema?: unknown; piId?: unknown; claims?: unknown };
        if (record.schema !== 1 || record.piId !== this.piId || !validCourseOwnership(record.claims))
            throw Error('Course ownership identity or claims changed.');
        return record.claims;
    }
    write(claims: OwnedCourse[]): void {
        if (!validCourseOwnership(claims)) throw Error('Invalid course ownership claims.');
        this.read(); // refuse overwriting a corrupt, foreign or symbolic-link receipt
        const data = JSON.stringify({ schema: 1, piId: this.piId, claims });
        if (Buffer.byteLength(data) > MAX_BYTES) throw Error('Course ownership storage is full.');
        fs.mkdirSync(this.root, { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        let fd: number | undefined;
        try {
            fd = fs.openSync(temporary, 'wx', 0o600);
            fs.writeFileSync(fd, data);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(temporary, this.file);
            if (process.platform !== 'win32') {
                const directory = fs.openSync(this.root, 'r');
                try {
                    fs.fsyncSync(directory);
                } finally {
                    fs.closeSync(directory);
                }
            }
        } catch (error) {
            if (fd !== undefined) fs.closeSync(fd);
            try {
                fs.unlinkSync(temporary);
            } catch {
                /* no staged file */
            }
            throw error;
        }
    }
}
