/** Source-release policy only: follow the real imported/exported runtime reader. */
import ts from 'typescript';
const MODULE = './boundedPublisherResponse.ts';
const FILE = 'services/weather/api/boundedPublisherResponse.ts';
const NAME = 'readBoundedResponse';
const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
/** @param {string} source @param {(file:string)=>string} read */
export function resolveBoundedReaderSource(source, read) {
    const refused = { bound: false, reader: '', module: '', file: FILE };
    const ast = parse('services/weather/api/cmemsGridTrust.ts', source);
    const imports = ast.statements.filter(ts.isImportDeclaration).flatMap((node) => {
        const bindings = node.importClause?.namedBindings;
        return bindings && ts.isNamedImports(bindings)
            ? bindings.elements.filter((e) => e.name.text === NAME).map((binding) => ({ node, binding }))
            : [];
    });
    if (imports.length !== 1) return refused;
    const { node, binding } = imports[0];
    if (
        node.importClause.isTypeOnly ||
        binding.isTypeOnly ||
        (binding.propertyName?.text ?? NAME) !== NAME ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== MODULE
    )
        return refused;
    const exported = ast.statements
        .filter(ts.isExportDeclaration)
        .filter(
            (node) =>
                !node.isTypeOnly &&
                node.moduleSpecifier &&
                ts.isStringLiteral(node.moduleSpecifier) &&
                node.moduleSpecifier.text === MODULE &&
                node.exportClause &&
                ts.isNamedExports(node.exportClause) &&
                node.exportClause.elements.some(
                    (e) => !e.isTypeOnly && e.name.text === NAME && (e.propertyName?.text ?? NAME) === NAME,
                ),
        );
    if (exported.length !== 1) return refused;
    // Refuse local shadowing or another declaration replacing this import.
    let shadow = false;
    const binds = (name) =>
        ts.isIdentifier(name)
            ? name.text === NAME
            : name.elements.some((e) => !ts.isOmittedExpression(e) && binds(e.name));
    const visit = (child) => {
        if ((ts.isVariableDeclaration(child) || ts.isParameter(child)) && binds(child.name)) shadow = true;
        if ((ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)) && child.name?.text === NAME)
            shadow = true;
        ts.forEachChild(child, visit);
    };
    visit(ast);
    if (shadow) return refused;
    const fetcher = ast.statements.find(
        (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'fetchBoundedPublisherBytes',
    );
    const calls = [];
    const collect = (child) => {
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === NAME)
            calls.push(child);
        ts.forEachChild(child, collect);
    };
    if (!fetcher) return refused;
    collect(fetcher);
    if (
        calls.length !== 1 ||
        calls[0].questionDotToken ||
        calls[0].arguments.map((a) => a.getText(ast)).join(',') !== 'response,maxBytes,controller.signal'
    )
        return refused;
    const module = read(FILE),
        target = parse(FILE, module);
    const readers = target.statements.filter((n) => ts.isFunctionDeclaration(n) && n.name?.text === NAME);
    if (
        readers.length !== 1 ||
        !readers[0].body ||
        !readers[0].modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
        !readers[0].modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    )
        return refused;
    return { bound: true, reader: readers[0].getText(target), module, file: FILE };
}
