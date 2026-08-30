import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from './s63Setup.js';

const { upsertConfValue } = __testing;

test('a missing section is created without disturbing what is there', () => {
    const conf = '[Settings]\nFullScreen=1\n';
    const out = upsertConfValue(conf, 'Userpermit', 'ABC123');
    assert.ok(out.includes('[Settings]\nFullScreen=1\n'), 'existing settings must survive');
    assert.ok(out.includes('[PlugIns/S63]\nUserpermit=ABC123'));
});

test('an existing value is replaced, not duplicated', () => {
    const conf = '[PlugIns/S63]\nUserpermit=OLD\nInstallpermit=DEADBEEF\n';
    const out = upsertConfValue(conf, 'Userpermit', 'NEW');
    assert.ok(out.includes('Userpermit=NEW'));
    assert.ok(!out.includes('Userpermit=OLD'));
    assert.equal(out.split('\n').filter((l) => l.startsWith('Userpermit=')).length, 1);
    assert.ok(out.includes('Installpermit=DEADBEEF'), 'the other permit must be left alone');
});

test('a new key lands inside its section, not after the next one', () => {
    // Appending at the end of the file would put the key under [ChartDirectories]
    // and the plugin would never see it.
    const conf = '[PlugIns/S63]\nUserpermit=ABC\n[ChartDirectories]\nDir0=/home/shanes/Charts\n';
    const out = upsertConfValue(conf, 'Installpermit', '11810BB4');
    const lines = out.split('\n');
    const section = lines.indexOf('[PlugIns/S63]');
    const inserted = lines.indexOf('Installpermit=11810BB4');
    const nextSection = lines.indexOf('[ChartDirectories]');
    assert.ok(section < inserted && inserted < nextSection, 'must sit inside [PlugIns/S63]');
    assert.ok(out.includes('Dir0=/home/shanes/Charts'), 'chart directories must survive');
});

test('a same-named key in another section is left alone', () => {
    // This is the one that would be silently destructive: OpenCPN config files
    // reuse key names across sections.
    const conf = '[PlugIns/Other]\nUserpermit=NOT_OURS\n[PlugIns/S63]\nUserpermit=OURS\n';
    const out = upsertConfValue(conf, 'Userpermit', 'CHANGED');
    assert.ok(out.includes('Userpermit=NOT_OURS'), 'the other plugin must be untouched');
    assert.ok(out.includes('Userpermit=CHANGED'));
});

test('an empty config produces a usable file', () => {
    const out = upsertConfValue('', 'Userpermit', 'ABC');
    assert.equal(out, '[PlugIns/S63]\nUserpermit=ABC\n');
});

test('the section header is matched case-insensitively', () => {
    // OpenCPN has written both [PlugIns/S63] and [plugins/s63] over the years.
    const conf = '[plugins/s63]\nUserpermit=OLD\n';
    const out = upsertConfValue(conf, 'Userpermit', 'NEW');
    assert.ok(out.includes('Userpermit=NEW'));
    assert.equal(out.split('\n').filter((l) => l.toLowerCase().startsWith('userpermit=')).length, 1);
});
