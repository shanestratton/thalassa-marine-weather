import { plainTextFromMarkup } from './plain-text.ts';

function assertEquals(actual: unknown, expected: unknown): void {
    if (Object.is(actual, expected)) return;
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

Deno.test('plain text scanner removes markup and hidden bodies while retaining structural breaks', () => {
    const markup = [
        'NAVAREA <strong>X</strong>',
        '<div>FIRST<br>SECOND<script>steal() <b>hidden</b></script></div>',
        '<style>.secret { display: block }</style><p>THIRD</p>',
    ].join('');

    assertEquals(
        plainTextFromMarkup(markup, { preserveLineBreaks: true }),
        'NAVAREA X\nFIRST\nSECOND\nTHIRD',
    );
});

Deno.test('plain text scanner decodes entities once and handles quoted tag delimiters', () => {
    const markup = '<span title="1 > 0">Tom &amp; Jerry &amp;lt;b&amp;gt; &lt;i&gt; &#x1F680;</span>';
    assertEquals(plainTextFromMarkup(markup), 'Tom & Jerry &lt;b&gt; <i> 🚀');
});

Deno.test('plain text scanner normalises CDATA markup, controls, and whitespace', () => {
    const markup = '<![CDATA[<p> Alpha\u0000\t beta </p><p>Gamma&#10;Delta</p>]]>';
    assertEquals(
        plainTextFromMarkup(markup, { preserveLineBreaks: true }),
        'Alpha beta\nGamma\nDelta',
    );
    assertEquals(plainTextFromMarkup(markup), 'Alpha beta Gamma Delta');
});

Deno.test('plain text scanner enforces independent input and output budgets', () => {
    assertEquals(plainTextFromMarkup('abcdefghij', { maxInputChars: 6, maxOutputChars: 4 }), 'abcd');
    assertEquals(
        plainTextFromMarkup('<script>ignored forever</script>safe', {
            maxInputChars: 100,
            maxOutputChars: 20,
        }),
        'safe',
    );
});
