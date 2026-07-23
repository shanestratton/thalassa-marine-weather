#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const migrationDirectory = path.resolve('supabase/migrations');
const grandfathered = new Set(['001_anchor_alarm_push.sql']);
const canonicalName = /^(\d{8,14})_[a-z0-9_]+\.sql$/;

const entries = (await readdir(migrationDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

const errors = [];
const versions = new Map();

for (const filename of entries) {
    if (grandfathered.has(filename)) continue;

    const match = filename.match(canonicalName);
    if (!match) {
        errors.push(`${filename}: migration names must start with an 8–14 digit version`);
        continue;
    }

    const version = match[1];
    const previous = versions.get(version);
    if (previous) {
        errors.push(`${filename}: version ${version} is already used by ${previous}`);
    } else {
        versions.set(version, filename);
    }
}

if (errors.length > 0) {
    console.error('Supabase migration audit failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
} else {
    console.log(`Supabase migration audit passed (${entries.length} files).`);
}
