import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [output, command, ...args] = process.argv.slice(2);
if (!output || !command) throw Error('Expected log file and explicit executable/arguments');
const limit = 2 * 1024 * 1024;
let tail = Buffer.alloc(0),
    total = 0;
const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
const append = (chunk) => {
    total += chunk.length;
    tail = Buffer.concat([tail, chunk]).subarray(-limit);
    writeFileSync(output, tail);
};
child.stdout.on('data', append);
child.stderr.on('data', append);
child.on('error', (error) => append(Buffer.from(String(error))));
const heartbeat = setInterval(() => console.log(`Unsigned build is running; ${total} log bytes observed.`), 30_000);
child.on('close', (code) => {
    clearInterval(heartbeat);
    writeFileSync(output, tail);
    process.stdout.write(tail.subarray(-64 * 1024));
    console.log(`\nRetained ${tail.length}/${total} log bytes; exit ${code}.`);
    process.exitCode = code ?? 1;
});
