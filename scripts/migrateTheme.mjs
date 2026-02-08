/**
 * Theme Migration Script v2
 * ─────────────────────────────────────────
 * Properly handles JSX className attributes by:
 * 1. Converting className="..." to className={`...`} when template expressions are inserted
 * 2. Preserving existing template literals that use ${...}
 * 3. Adding useTheme import and hook call
 */

import fs from 'fs';
import path from 'path';

const PROJECT = '/Users/shanestratton/Projects/thalassa-marine-weather';

const FILES = [
    'pages/LogPage.tsx',
    'components/AnchorWatchPage.tsx',
    'components/VoyageResults.tsx',
    'components/CommunityTrackBrowser.tsx',
    'components/dashboard/TideAndVessel.tsx',
    'components/OnboardingWizard.tsx',
    'components/passage/FloatPlanExport.tsx',
    'components/WeatherMap.tsx',
    'components/RoutePlanner.tsx',
    'components/DateGroupedTimeline.tsx',
    'components/SkeletonLoader.tsx',
    'components/dashboard/WeatherCharts.tsx',
    'components/AddEntryModal.tsx',
    'components/SettingsModal.tsx',
    'components/LogFilterToolbar.tsx',
    'components/EditEntryModal.tsx',
    'components/DeleteVoyageModal.tsx',
    'components/map/MapUI.tsx',
    'components/dashboard/WeatherGrid.tsx',
    'components/TrackMapViewer.tsx',
];

// Map: bg-slate class → th.colors.bg token name
const BG_MAP = {
    'bg-slate-950': 'th.colors.bg.base',
    'bg-[#0f172a]': 'th.colors.bg.base',
    'bg-[#0F172A]': 'th.colors.bg.base',
    'bg-slate-900/95': 'th.colors.bg.elevated',
    'bg-slate-900/90': 'th.colors.bg.glass',
    'bg-slate-900/80': 'th.colors.bg.glass',
    'bg-slate-900/70': 'th.colors.bg.surface',
    'bg-slate-900/50': 'th.colors.bg.surfaceAlt',
    'bg-slate-900/40': 'th.colors.bg.surfaceAlt',
    'bg-slate-900': 'th.colors.bg.elevated',
    'bg-slate-800/80': 'th.colors.bg.insetDeep',
    'bg-slate-800/60': 'th.colors.bg.insetDeep',
    'bg-slate-800/50': 'th.colors.bg.inset',
    'bg-slate-800/40': 'th.colors.bg.inset',
    'bg-slate-800': 'th.colors.bg.inset',
};

function getImportPath(filePath) {
    const dir = path.dirname(filePath);
    const contextDir = path.join(PROJECT, 'context');
    const rel = path.relative(dir, contextDir);
    return rel + '/ThemeContext';
}

function migrateFile(relPath) {
    const fullPath = path.join(PROJECT, relPath);
    let content = fs.readFileSync(fullPath, 'utf8');
    const original = content;
    let totalReplacements = 0;

    if (content.includes('const th = useTheme()')) {
        console.log(`  ⏭️  ${relPath} — already migrated`);
        return 0;
    }

    // ── Step 1: Add useTheme import ──
    const importPath = getImportPath(relPath);
    if (!content.includes('useTheme')) {
        const lines = content.split('\n');
        let lastImportLine = -1;
        for (let i = 0; i < Math.min(lines.length, 40); i++) {
            if (lines[i].trimStart().startsWith('import ')) {
                lastImportLine = i;
            }
        }
        if (lastImportLine >= 0) {
            lines.splice(lastImportLine + 1, 0, `import { useTheme } from '${importPath}';`);
            content = lines.join('\n');
        }
    }

    // ── Step 2: Add `const th = useTheme()` ──
    // Find the main exported component function/const and inject after the opening brace
    // Pattern: `export const Foo = (...) => {` or `export function Foo(...) {`
    const exportMatch = content.match(/export\s+(const|function)\s+(\w+).*?(?:=>|)\s*\{/);
    if (exportMatch && exportMatch.index !== undefined) {
        const afterBrace = content.indexOf('{', exportMatch.index + exportMatch[0].indexOf('{'));
        if (afterBrace > -1) {
            const afterContent = content.slice(afterBrace + 1, afterBrace + 100);
            if (!afterContent.includes('const th = useTheme()')) {
                content = content.slice(0, afterBrace + 1) + '\n    const th = useTheme();' + content.slice(afterBrace + 1);
            }
        }
    }

    // ── Step 3: Replace bg-slate-* patterns ──
    // Process line by line to handle JSX string quoting properly
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        let modified = false;

        // Sort replacement keys by length (longest first) to avoid partial matches
        const sortedKeys = Object.keys(BG_MAP).sort((a, b) => b.length - a.length);

        for (const bgClass of sortedKeys) {
            if (!line.includes(bgClass)) continue;

            const token = BG_MAP[bgClass];
            const replacement = '${' + token + '}';

            // Replace the class
            while (line.includes(bgClass)) {
                line = line.replace(bgClass, replacement);
                totalReplacements++;
                modified = true;
            }
        }

        if (modified) {
            // Now fix the string delimiters:
            // If line has className="...${th...}..." → className={`...${th...}...`}
            // If line has "...${th...}..." in a non-className context → `...${th...}...`

            // Handle className="...${...}..."  → className={`...${...}...`}
            line = line.replace(/className="([^"]*\$\{th\.[^"]+)"/g, 'className={`$1`}');

            // Handle className='...${}...' → className={`...`}
            line = line.replace(/className='([^']*\$\{th\.[^']+)'/g, 'className={`$1`}');

            // Handle non-className double-quoted strings with ${th.}
            // e.g. <div className={`foo ${condition ? "bar ${th.colors.bg.elevated}" : ""}`}>
            // These are trickier — replace inner double-quoted segments
            line = line.replace(/"([^"]*\$\{th\.colors[^"]+)"/g, '`$1`');

            lines[i] = line;
        }
    }

    content = lines.join('\n');

    if (content !== original) {
        fs.writeFileSync(fullPath, content);
        console.log(`  ✅ ${relPath} — ${totalReplacements} bg replacements`);
        return totalReplacements;
    } else {
        console.log(`  ⏭️  ${relPath} — no changes`);
        return 0;
    }
}

console.log('🎨 Theme Migration v2 — Starting...\n');
let total = 0;
for (const f of FILES) {
    try {
        total += migrateFile(f);
    } catch (e) {
        console.log(`  ❌ ${f} — ${e.message}`);
    }
}
console.log(`\n✅ Done! ${total} total replacements.`);
