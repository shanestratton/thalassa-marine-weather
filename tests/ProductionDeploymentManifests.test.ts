import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

describe('production deployment manifests', () => {
    it('builds the AIS worker from its lockfile and runs compiled code as a non-root user', () => {
        const dockerfile = read('workers/ais-ingest/Dockerfile');
        const railway = read('workers/ais-ingest/railway.toml');
        const dockerignore = read('workers/ais-ingest/.dockerignore');

        expect(dockerfile).toContain('COPY package.json package-lock.json ./');
        expect(dockerfile).toContain('RUN npm ci --no-audit --no-fund');
        expect(dockerfile).not.toMatch(/RUN npm install(?:\s|$)/);
        expect(dockerfile).toContain('RUN npm run build');
        expect(dockerfile).toContain('RUN npm prune --omit=dev --no-audit');
        expect(dockerfile).toContain('USER node');
        expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
        expect(read('workers/ais-ingest/tsconfig.json')).toContain('"*.test.ts"');
        expect(read('workers/ais-ingest/tsconfig.json')).toContain('"vitest.config.ts"');
        expect(railway).toContain('builder = "DOCKERFILE"');
        expect(railway).toContain('dockerfilePath = "Dockerfile"');
        expect(railway).toContain('startCommand = "node dist/index.js"');
        expect(dockerignore).toMatch(/^node_modules$/m);
        expect(dockerignore).toMatch(/^\.env\.\*$/m);
    });

    it('installs the Pi service from its lockfile on first install and redeploy', () => {
        const install = read('pi-cache/install.sh');
        const redeploy = read('pi-cache/redeploy.sh');

        expect(install).toContain('npm ci --prefix "$INSTALL_DIR" --no-audit --no-fund');
        expect(install).toContain('npm prune --omit=dev --prefix "$INSTALL_DIR" --no-audit');
        expect(install).not.toContain('npm install --prefix "$INSTALL_DIR"');
        expect(redeploy).toContain('npm ci --silent --no-audit --no-fund');
        expect(redeploy).toContain('npm prune --omit=dev --silent --no-audit');
        expect(redeploy).not.toContain('npm install --silent');
        expect(redeploy.indexOf('npm ci --silent --no-audit --no-fund')).toBeLessThan(
            redeploy.indexOf('npm run build --silent'),
        );
        expect(redeploy.indexOf('npm run build --silent')).toBeLessThan(
            redeploy.indexOf('npm prune --omit=dev --silent --no-audit'),
        );
        expect(redeploy.indexOf('npm prune --omit=dev --silent --no-audit')).toBeLessThan(
            redeploy.indexOf('systemctl restart'),
        );
    });

    it('keeps the retired Railway vessel scraper impossible to start or build', () => {
        const dockerfile = read('vessel-scraper/Dockerfile');
        const railway = read('vessel-scraper/railway.toml');
        const packageJson = JSON.parse(read('vessel-scraper/package.json')) as {
            private?: boolean;
            description?: string;
            scripts?: Record<string, string>;
        };

        expect(dockerfile).toContain('vessel-scraper is retired; do not deploy');
        expect(dockerfile).toContain('exit 78');
        expect(railway).not.toContain('cronSchedule');
        expect(railway).toContain('watchPatterns = ["RETIRED_DO_NOT_DEPLOY"]');
        expect(packageJson.private).toBe(true);
        expect(packageJson.description).toMatch(/retired archive/i);
        expect(packageJson.scripts?.start).toContain('process.exit(78)');
        expect(packageJson.scripts).not.toHaveProperty('dev');
    });
});
