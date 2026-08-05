import { classifyDeepgramFrame } from './safety.ts';

function assertEquals(actual: unknown, expected: unknown): void {
    if (Object.is(actual, expected)) return;
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

Deno.test('Deepgram frame diagnostics allowlist known message kinds', () => {
    for (const kind of ['Results', 'Metadata', 'UtteranceEnd', 'SpeechStarted', 'Finalize', 'Error']) {
        assertEquals(classifyDeepgramFrame(JSON.stringify({ type: kind, transcript: 'must not be logged' })), kind);
    }
});

Deno.test('Deepgram frame diagnostics never return attacker-controlled labels or transcript text', () => {
    assertEquals(classifyDeepgramFrame('{"type":"Injected\\nlog","transcript":"secret"}'), 'other-json');
    assertEquals(classifyDeepgramFrame('not-json\nsecret transcript'), 'text');
    assertEquals(classifyDeepgramFrame(new ArrayBuffer(8)), 'binary');
});
