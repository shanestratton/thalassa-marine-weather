import fs from 'fs';
import path from 'path';

const PROJECT = '/Users/shanestratton/Projects/thalassa-marine-weather';
const FILES = [
    'components/AnchorWatchPage.tsx',
    'components/CommunityTrackBrowser.tsx',
    'components/passage/FloatPlanExport.tsx',
];

for (const relPath of FILES) {
    const fullPath = path.join(PROJECT, relPath);
    let content = fs.readFileSync(fullPath, 'utf8');
    let fixes = 0;

    // Go char by char and fix mismatched template literal closings
    // Strategy: find patterns where className={` is opened but ` is not properly closed
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Find all className={` or just {` openings in the line and check if they're closed with '} instead of `}
        let newLine = '';
        let j = 0;

        while (j < line.length) {
            // Look for {` pattern
            if (line[j] === '{' && j + 1 < line.length && line[j + 1] === '`') {
                // Found a template literal opening inside JSX expression
                // Scan forward to find the closing delimiter
                let k = j + 2;
                let depth = 1; // Track ${} depth
                let foundClose = false;

                while (k < line.length) {
                    if (line[k] === '$' && k + 1 < line.length && line[k + 1] === '{') {
                        depth++;
                        k += 2;
                        continue;
                    }
                    if (line[k] === '}' && depth > 1) {
                        depth--;
                        k++;
                        continue;
                    }
                    if (line[k] === '`' && k + 1 < line.length && line[k + 1] === '}') {
                        // Properly closed template literal - all good
                        newLine += line.slice(j, k + 2);
                        j = k + 2;
                        foundClose = true;
                        break;
                    }
                    if (line[k] === "'" && k + 1 < line.length && line[k + 1] === '}') {
                        // BROKEN: single quote closing a template literal
                        // Fix it: replace ' with `
                        newLine += line.slice(j, k) + '`}';
                        j = k + 2;
                        foundClose = true;
                        fixes++;
                        break;
                    }
                    k++;
                }

                if (!foundClose) {
                    // Couldn't find closing - just pass through
                    newLine += line[j];
                    j++;
                }
            } else {
                newLine += line[j];
                j++;
            }
        }

        lines[i] = newLine;
    }

    content = lines.join('\n');
    fs.writeFileSync(fullPath, content);
    console.log(`✅ ${relPath}: ${fixes} template literal closings fixed`);
}
