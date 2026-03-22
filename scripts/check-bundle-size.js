#!/usr/bin/env node

/**
 * Bundle Size Check — Reports dist/ size and warns if over budget.
 *
 * Usage: node scripts/check-bundle-size.js
 *
 * Budget: 5MB total (excluding source maps)
 */

// eslint-disable-next-line no-undef
const fs = require('fs');
// eslint-disable-next-line no-undef
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const BUDGET_MB = 5;
const BUDGET_BYTES = BUDGET_MB * 1024 * 1024;

function getFiles(dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            getFiles(full, files);
        } else if (!entry.name.endsWith('.map')) {
            files.push({ path: full.replace(DIST + '/', ''), size: fs.statSync(full).size });
        }
    }
    return files;
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

const files = getFiles(DIST);
if (files.length === 0) {
    console.error('❌ No dist/ directory found. Run `npm run build` first.');
    process.exit(1);
}

const total = files.reduce((sum, f) => sum + f.size, 0);
const js = files.filter((f) => f.path.endsWith('.js'));
const css = files.filter((f) => f.path.endsWith('.css'));
const other = files.filter((f) => !f.path.endsWith('.js') && !f.path.endsWith('.css'));

const jsTotal = js.reduce((s, f) => s + f.size, 0);
const cssTotal = css.reduce((s, f) => s + f.size, 0);

console.log('');
console.log('📦 Bundle Size Report');
console.log('═'.repeat(50));
console.log(`   Total:  ${formatSize(total)} (${files.length} files)`);
console.log(`   JS:     ${formatSize(jsTotal)} (${js.length} files)`);
console.log(`   CSS:    ${formatSize(cssTotal)} (${css.length} files)`);
console.log(`   Other:  ${formatSize(total - jsTotal - cssTotal)} (${other.length} files)`);
console.log('');

// Top 5 largest files
const sorted = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
console.log('📊 Largest Files:');
for (const f of sorted) {
    console.log(`   ${formatSize(f.size).padEnd(10)} ${f.path}`);
}
console.log('');

if (total > BUDGET_BYTES) {
    console.log(`⚠️  Over budget! ${formatSize(total)} > ${BUDGET_MB}MB`);
    console.log('   Consider tree-shaking or code splitting.');
    process.exit(1);
} else {
    const pct = ((total / BUDGET_BYTES) * 100).toFixed(0);
    console.log(`✅ Within budget: ${formatSize(total)} / ${BUDGET_MB}MB (${pct}%)`);
}
console.log('');
