// Update 7 snapshot of the reviewed update-5 protocol; shared guard compatibility is intentional.
import { rollback } from './update7.mjs';
if (!process.argv.includes('--apply'))
    process.stdout.write(
        'PLAN ONLY: rollback requires --apply, Linux root, a complete prior-code backup, fresh maintenance status, and no active anchor lease. Runtime data is retained.\n',
    );
else {
    const index = process.argv.indexOf('--cache-dir'),
        portIndex = process.argv.indexOf('--port');
    process.stdout.write(
        JSON.stringify(
            await rollback({
                ...(index >= 0 ? { cacheDir: process.argv[index + 1] } : {}),
                ...(portIndex >= 0 ? { port: Number(process.argv[portIndex + 1]) } : {}),
            }),
            null,
            2,
        ) + '\n',
    );
}
