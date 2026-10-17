/**
 * A date of birth goes to the float plan as an age and to the person's own
 * skipper, and nowhere else (129-14): never the public voyage page, the
 * crew's view of the boat, a log line or the float plan's printed text.
 *
 * The behaviour is proven where it happens (tests/FloatPlanNeverPrintsDateOfBirth.test.ts,
 * tests/FloatPlanCrewDateOfBirth.test.ts). This pins the boundary in the
 * source, so a later edit that hands the field to one of those places has to
 * change this file too.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const BIRTH = /dateOfBirth|date_of_birth/;

function files(directory: string): string[] {
    return readdirSync(join(process.cwd(), directory)).flatMap((name) => {
        const path = `${directory}/${name}`;
        if (statSync(join(process.cwd(), path)).isDirectory()) return files(path);
        return /\.(ts|tsx|js|mjs|html)$/.test(name) ? [path] : [];
    });
}

describe('a date of birth stays private', () => {
    it("never reaches the float plan's printed text: the plan, its PDF and its shared formatters", () => {
        for (const path of ['services/floatPlan.ts', 'services/floatPlanPdf.ts', ...files('services/pdf')]) {
            expect(read(path), path).not.toMatch(BIRTH);
        }
    });

    it('never reaches the public voyage page or its server', () => {
        for (const path of [...files('src'), ...files('supabase/functions/voyage-log'), 'public/voyage-log-api.html']) {
            expect(read(path), path).not.toMatch(BIRTH);
        }
    });

    it("never reaches the crew's view of the boat, which hands crew names and ranks only", () => {
        expect(read('services/crew/crewVesselView.ts')).not.toMatch(BIRTH);
        expect(read('supabase/migrations/20261003120000_crew_vessel_view.sql')).not.toMatch(BIRTH);
    });

    it('is never written to a log line where it is handled', () => {
        for (const path of [
            'services/crew/crewFloatPlanDetails.ts',
            'services/floatPlanCrew.ts',
            'services/crew/floatPlanPeople.ts',
            'services/crew/dateOfBirth.ts',
            'services/crew/dateOfBirthColumn.ts',
            'hooks/useShareMyFloatPlanDetailsOnEdit.ts',
            'components/settings/VesselTab.tsx',
        ]) {
            const logs = read(path).match(/\b(?:log|console)\.\w+\([^;]*\)/g) ?? [];
            for (const line of logs) {
                expect(line, path).not.toMatch(BIRTH);
                // A failed write or read logs the server's message only, never the row or the details.
                const values = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
                expect(values, path).not.toMatch(/\b(?:details|row|own|shared|vessel|crewRoster|person)\b/);
            }
        }
    });
});
