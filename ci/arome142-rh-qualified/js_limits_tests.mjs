// Actual production parser, exact retained Linux /proc line; no system or network calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertJsAddressSpaceLimit } from './js_limits.mjs';
// Retained V3 run39048280679/job117441348237 generated-js-interop.txt.
const actualLinuxLine = 'Max address space         17179869184          17179869184          bytes     ';
test('accepts the actual Linux line with trailing horizontal spaces', () => {
    assert.doesNotThrow(() => assertJsAddressSpaceLimit(actualLinuxLine + '\n'));
    assert.doesNotThrow(() => assertJsAddressSpaceLimit(actualLinuxLine + '\t \n'));
});
test('accepts exact integers and bytes without trailing spaces', () => {
    assert.doesNotThrow(() => assertJsAddressSpaceLimit('Max address space 17179869184 17179869184 bytes'));
});
test('refuses either wrong soft or hard limit', () => {
    for (const line of ['Max address space 17179869183 17179869184 bytes', 'Max address space 17179869184 17179869185 bytes']) {
        assert.throws(() => assertJsAddressSpaceLimit(line), /exact 16GiB/);
    }
});
test('refuses wrong units and non-horizontal trailing whitespace', () => {
    for (const line of ['Max address space 17179869184 17179869184 KiB', actualLinuxLine + '\r', actualLinuxLine + '\v']) {
        assert.throws(() => assertJsAddressSpaceLimit(line), /exact 16GiB/);
    }
});
test('refuses extra row values, duplicate labels and a cross-line split', () => {
    for (const line of [actualLinuxLine + ' 1', actualLinuxLine + '\n' + actualLinuxLine, 'Max address space 17179869184\n17179869184 bytes', 'Max address spaceX 17179869184 17179869184 bytes']) {
        assert.throws(() => assertJsAddressSpaceLimit(line), /exact 16GiB/);
    }
});
