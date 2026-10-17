// @vitest-environment node
import { expect, it } from 'vitest';
import { compareWorkerBindings } from '../browser-tests/helpers/workerBindingEquivalence.mjs';
const original =
    'var stable={};(function(root){let a=1;function method(b){const c=b+a;return x=>({field:c+x+root.value,global:outside});}root.answer=method(a);})(stable);';
const renamed =
    'var stable={};(function(scope){let x=1;function local(y){const z=y+x;return inner=>({field:z+inner+scope.value,global:outside});}scope.answer=local(x);})(stable);';
it('accepts only resolved lexical renames across nested closures with exact free names, keys and literals', () => {
    const result = compareWorkerBindings(original, renamed);
    expect(result.equivalent).toBe(true);
    expect(result.byteIdentical).toBe(false);
    expect(result.renamedBindings).toBeGreaterThan(0);
    expect(result.originalAstSha256).toBe(result.packedAstSha256);
});
it.each([
    renamed.replace('outside', 'anotherGlobal'),
    renamed.replace('field:', 'changed:'),
    renamed.replace('scope.value', 'scope.changed'),
    renamed.replace('let x=1', 'let x=2'),
    renamed.replace('z+inner', 'y+inner'),
    renamed.replace('z+inner', 'z-inner'),
    renamed.replace('stable={}', 'changedGlobal={}').replace('(stable)', '(changedGlobal)'),
    renamed.replace('scope.answer=local(x)', 'scope.answer=local(x);scope.extra=1'),
    renamed.replace('const z=y+x', 'const z=x+y'),
])('refuses property/literal/free/global/capture/control/order changes %#', (changed) => {
    expect(compareWorkerBindings(original, changed).equivalent).toBe(false);
});
it('retains an uncomputed property key when shorthand expands due to a binding rename', () => {
    expect(
        compareWorkerBindings('(function(field){return {field}})(1)', '(function(local){return {field:local}})(1)')
            .equivalent,
    ).toBe(true);
    expect(
        compareWorkerBindings('(function(field){return {field}})(1)', '(function(local){return {local}})(1)')
            .equivalent,
    ).toBe(false);
});
it('resolves shadowed catch/argument/class bindings and lexical labels without renaming their property names', () => {
    expect(
        compareWorkerBindings(
            '(function(a){class Item{self(){return Item}}try{throw a}catch(e){return ()=>e}})(1)',
            '(function(x){class Other{self(){return Other}}try{throw x}catch(y){return ()=>y}})(1)',
        ).equivalent,
    ).toBe(true);
    expect(
        compareWorkerBindings(
            '(function(){outer:for(let i=0;i<2;i++){if(i)break outer;}})()',
            '(function(){renamed:for(let x=0;x<2;x++){if(x)break renamed;}})()',
        ).equivalent,
    ).toBe(true);
});
it('fails closed on dynamic eval and with scopes', () => {
    expect(() =>
        compareWorkerBindings('(function(a){return eval("a")})(1)', '(function(b){return eval("a")})(1)'),
    ).toThrow('Dynamic scope');
    expect(() => compareWorkerBindings('with(x){y=z}', 'with(x){y=z}')).toThrow('Dynamic scope');
});
it('preserves tagged-template raw bytes, regex patterns and private property names', () => {
    expect(compareWorkerBindings('tag`\\n`', 'tag`\n`').equivalent).toBe(false);
    expect(
        compareWorkerBindings('(function(a){return /a/i.test(a)})(1)', '(function(x){return /a/g.test(x)})(1)')
            .equivalent,
    ).toBe(false);
    expect(
        compareWorkerBindings(
            '(function(){return class{#a=1;get(){return this.#a}}})()',
            '(function(){return class{#b=1;get(){return this.#b}}})()',
        ).equivalent,
    ).toBe(false);
});
it('states the lexical proof limit for observable function names without executing generated source', () => {
    function originalName() {}
    function renamedName() {}
    expect(originalName.name).not.toBe(renamedName.name);
    expect(
        compareWorkerBindings(
            '(function(){function original(){}return original.name})()',
            '(function(){function renamed(){}return renamed.name})()',
        ).equivalent,
    ).toBe(true);
});
