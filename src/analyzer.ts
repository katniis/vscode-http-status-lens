import ts from "typescript";
import type { AnalysisResult, DocumentAnalyzer, ImportedSource, ModuleResolver, RouteAnalysis, StatusFact, StatusLiteral } from "./model.js";
import type { StatusSuggestion } from "./model.js";
import { inferStatusFromContext } from "./status-suggestions.js";

const routeMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

function moduleName(source: ts.ImportDeclaration | ts.VariableDeclaration): string | undefined {
  if (ts.isImportDeclaration(source) && ts.isStringLiteral(source.moduleSpecifier)) return source.moduleSpecifier.text;
  if (ts.isVariableDeclaration(source) && source.initializer && ts.isCallExpression(source.initializer) &&
    ts.isIdentifier(source.initializer.expression) && source.initializer.expression.text === "require" &&
    source.initializer.arguments[0] && ts.isStringLiteral(source.initializer.arguments[0])) {
    return source.initializer.arguments[0].text;
  }
  return undefined;
}

function expressBindings(source: ts.SourceFile): Set<string> {
  const expressNames = new Set<string>();
  const routerNames = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && moduleName(statement) === "express") {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) expressNames.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) expressNames.add(clause.namedBindings.name.text);
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) if (item.propertyName?.text === "Router" || item.name.text === "Router") routerNames.add(item.name.text);
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (moduleName(declaration) !== "express" || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
        if (ts.isIdentifier(declaration.name)) expressNames.add(declaration.name.text);
        if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (element.propertyName?.getText(source) === "Router" || element.name.getText(source) === "Router") routerNames.add(element.name.getText(source));
          }
        }
      }
    }
  }

  const receivers = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && expressNames.has(callee.text) && node.initializer.arguments.length === 0) receivers.add(node.name.text);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "Router" && ts.isIdentifier(callee.expression) && expressNames.has(callee.expression.text)) receivers.add(node.name.text);
      if (ts.isIdentifier(callee) && routerNames.has(callee.text)) receivers.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return receivers;
}

function routePath(expression: ts.Expression, receivers: ReadonlySet<string>): ts.Expression | undefined {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
  const property = expression.expression;
  if (property.name.text === "route" && ts.isIdentifier(property.expression) && receivers.has(property.expression.text)) return expression.arguments[0];
  return routePath(property.expression, receivers);
}

function pathText(path: ts.Expression | undefined): string {
  if (!path) return "<dynamic path>";
  if (ts.isStringLiteralLike(path)) return path.text;
  if (ts.isNoSubstitutionTemplateLiteral(path)) return path.text;
  return "<dynamic path>";
}

function routeCall(node: ts.CallExpression, receivers: ReadonlySet<string>): { method: string; path: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const { expression, name } = node.expression;
  const method = name.text.toLowerCase();
  if (!routeMethods.has(method)) return undefined;

  const directRoute = ts.isIdentifier(expression) && receivers.has(expression.text);
  const path = directRoute ? node.arguments[0] : routePath(expression, receivers);
  if (!path && !directRoute) return undefined;
  return {
    method: method.toUpperCase(),
    path: pathText(path),
  };
}

type Handler = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

interface ImportedHandlerBinding {
  readonly moduleSpecifier: string;
  readonly exportedName: string;
}

function functionBody(node: ts.Node | undefined): Handler | undefined {
  if (!node) return undefined;
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) return node as Handler;
  if (ts.isFunctionDeclaration(node) && node.body) return node as Handler;
  return undefined;
}

function numericArgument(expression: ts.Expression | undefined): number | undefined {
  if (!expression || !ts.isNumericLiteral(expression)) return undefined;
  const value = Number(expression.text.replaceAll("_", ""));
  return Number.isFinite(value) ? value : undefined;
}

function handlerMap(source: ts.SourceFile): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const body = functionBody(statement);
      if (body) handlers.set(statement.name.text, body);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const body = functionBody(declaration.initializer);
          if (body) handlers.set(declaration.name.text, body);
        }
      }
    }
  }
  return handlers;
}

function importedHandlerBindings(source: ts.SourceFile): Map<string, ImportedHandlerBinding> {
  const handlers = new Map<string, ImportedHandlerBinding>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause.name) handlers.set(clause.name.text, { moduleSpecifier, exportedName: "default" });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const item of clause.namedBindings.elements) {
        handlers.set(item.name.text, { moduleSpecifier, exportedName: item.propertyName?.text ?? item.name.text });
      }
    }
  }
  return handlers;
}

function exportedHandlerMap(source: ts.SourceFile): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
      const handler = functionBody(statement);
      if (handler) {
        const isDefault = statement.modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword);
        if (isDefault) handlers.set("default", handler);
        else if (statement.name) handlers.set(statement.name.text, handler);
      }
    } else if (ts.isVariableStatement(statement) && statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const handler = functionBody(declaration.initializer);
        if (handler) handlers.set(declaration.name.text, handler);
      }
    } else if (ts.isExportAssignment(statement)) {
      const handler = functionBody(statement.expression);
      if (handler) handlers.set("default", handler);
    }
  }
  return handlers;
}

function handlerFunctions(node: ts.CallExpression, receivers: ReadonlySet<string>, source: ts.SourceFile, known: ReadonlyMap<string, Handler>, imported: (name: string) => Handler | undefined): Handler[] {
  if (!ts.isPropertyAccessExpression(node.expression)) return [];
  const receiver = node.expression.expression;
  const directRoute = ts.isIdentifier(receiver) && receivers.has(receiver.text);
  const args = directRoute ? node.arguments.slice(1) : node.arguments;
  const result: Handler[] = [];
  for (const argument of args) {
    const inline = functionBody(argument);
    if (inline) result.push(inline);
    else if (ts.isIdentifier(argument)) {
      const resolved = known.get(argument.text) ?? imported(argument.text);
      if (resolved) result.push(resolved);
    }
  }
  return result;
}

function explicitStatusLiterals(handler: Handler): StatusLiteral[] {
  const response = responseName(handler);
  if (!response || !handler.body) return [];
  const responseIdentifier = response;
  const literals: StatusLiteral[] = [];
  function visit(node: ts.Node): void {
    if (node !== handler.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isCallExpression(node)) {
      const method = responseCall(node, responseIdentifier);
      const argument = node.arguments[0];
      const hasExplicitCode = method === "status" || method === "sendStatus" || (method === "redirect" && node.arguments.length > 1);
      const code = hasExplicitCode ? numericArgument(argument) : undefined;
      if (code !== undefined && argument) literals.push({ code, range: { start: argument.getStart(), end: argument.end } });
    }
    ts.forEachChild(node, visit);
  }
  visit(handler.body);
  return literals;
}

function responseName(handler: Handler): string | undefined {
  const parameter = handler.parameters[1]?.name;
  return parameter && ts.isIdentifier(parameter) ? parameter.text : undefined;
}

function responseCall(node: ts.CallExpression, response: string): string | undefined {
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === response) {
    return node.expression.name.text;
  }
  return undefined;
}

const responseMethods = new Set(["status", "sendStatus", "send", "json", "jsonp", "end", "render", "sendFile", "download", "redirect"]);

function hasResponseMethod(handler: Handler, response: string): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found || (node !== handler.body && (ts.isFunctionLike(node) || ts.isClassLike(node)))) return;
    if (ts.isCallExpression(node) && responseMethods.has(responseCall(node, response) ?? "")) found = true;
    ts.forEachChild(node, visit);
  }
  visit(handler.body);
  return found;
}

function missingValue(expression: ts.Expression): { name: string; missingInThen: boolean } | undefined {
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(expression.operand)) {
    return { name: expression.operand.text, missingInThen: true };
  }
  if (!ts.isBinaryExpression(expression) || ![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(expression.operatorToken.kind)) return undefined;
  const equals = expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken || expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const pairs = [[expression.left, expression.right], [expression.right, expression.left]] as const;
  for (const [value, empty] of pairs) {
    if (!ts.isIdentifier(value)) continue;
    if (empty.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(empty) && empty.text === "undefined")) return { name: value.text, missingInThen: equals };
  }
  return undefined;
}

function lookupInitializer(handler: Handler, name: string): string | undefined {
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (node !== handler.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(handler.body);
  if (!initializer) return undefined;
  let lookup: string | undefined;
  function findCall(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["findById", "findOne", "findUnique", "findByPk", "findFirst"].includes(node.expression.name.text)) {
      lookup = node.expression.name.text;
    }
    ts.forEachChild(node, findCall);
  }
  findCall(initializer);
  return lookup;
}

function statusSuggestionsForHandler(handler: Handler, source: ts.SourceFile): StatusSuggestion[] {
  const response = responseName(handler);
  if (!response || !(new Set(["res", "response", "reply"]).has(response.toLowerCase()) || hasResponseMethod(handler, response))) return [];
  const suggestions: StatusSuggestion[] = [];
  function add(branch: ts.Node, context: string, missing?: { name: string; missing: boolean }): void {
    const lookup = missing?.missing ? lookupInitializer(handler, missing.name) : undefined;
    const inferred = lookup ? { code: 404, detail: "Suggested from a missing lookup result: 404 Not Found" } : inferStatusFromContext(context);
    if (!inferred) return;
    suggestions.push({ code: inferred.code, detail: inferred.detail, range: { start: branch.getStart(source), end: branch.end } });
  }
  function visit(node: ts.Node): void {
    if (node !== handler.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isIfStatement(node)) {
      const condition = missingValue(node.expression);
      const thenMissing = condition ? condition.missingInThen : false;
      const thenContext = `${node.expression.getText(source)} ${node.thenStatement.getText(source)}`;
      add(node.thenStatement, thenContext, condition && { name: condition.name, missing: thenMissing });
      if (node.elseStatement) {
        const elseContext = `${node.expression.getText(source)} ${node.elseStatement.getText(source)}`;
        add(node.elseStatement, elseContext, condition && { name: condition.name, missing: !thenMissing });
      }
    } else if (ts.isConditionalExpression(node)) {
      const condition = missingValue(node.condition);
      add(node.whenTrue, `${node.condition.getText(source)} ${node.whenTrue.getText(source)}`, condition && { name: condition.name, missing: condition.missingInThen });
      add(node.whenFalse, `${node.condition.getText(source)} ${node.whenFalse.getText(source)}`, condition && { name: condition.name, missing: !condition.missingInThen });
    } else if (ts.isCatchClause(node)) {
      add(node.block, node.getText(source));
    } else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      add(node, node.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  if (handler.body) visit(handler.body);
  return suggestions;
}

function statusCallInChain(node: ts.CallExpression, response: string): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const receiver = node.expression.expression;
  if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression)) return false;
  if (responseCall(receiver, response) === "status") return true;
  return statusCallInChain(receiver, response);
}

function precedingStatus(node: ts.Node, response: string): boolean {
  const statement = node.parent;
  if (!ts.isStatement(statement)) return false;
  const block = statement.parent;
  if (!ts.isBlock(block)) return false;
  const index = block.statements.indexOf(statement);
  const previous = block.statements[index - 1];
  if (!previous || !ts.isExpressionStatement(previous) || !ts.isCallExpression(previous.expression)) return false;
  return responseCall(previous.expression, response) === "status";
}

function extractStatuses(handler: Handler): StatusFact[] {
  const response = responseName(handler);
  if (!response || !handler.body) return [];
  const responseIdentifier = response;
  const facts: StatusFact[] = [];
  let hasStatusSetter = false;

  function visit(node: ts.Node): void {
    if (node !== handler.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isCallExpression(node)) {
      const method = responseCall(node, responseIdentifier);
      if (method === "status" || method === "sendStatus") {
        hasStatusSetter ||= method === "status";
        const argument = node.arguments[0];
        const code = numericArgument(argument);
        if (code !== undefined) facts.push({ kind: "explicit", code });
        else facts.push({ kind: "dynamic" });
      } else if (method === "redirect") {
        const first = node.arguments[0];
        if (node.arguments.length > 1) {
          const code = numericArgument(first);
          if (code !== undefined) facts.push({ kind: "explicit", code });
          else facts.push({ kind: "dynamic" });
        } else facts.push({ kind: "implicit", code: 302 });
      } else if (["send", "json", "jsonp", "end", "render", "sendFile", "download"].includes(method ?? "")) {
        if (!statusCallInChain(node, responseIdentifier) && !precedingStatus(node, responseIdentifier)) facts.push({ kind: "implicit", code: 200 });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(handler.body);

  if (hasStatusSetter && facts.some((fact) => fact.kind === "implicit" && fact.code === 200)) {
    const unmatchedTerminal = facts.some((fact) => fact.kind === "implicit" && fact.code === 200);
    if (unmatchedTerminal) {
      // Conservative: a setter in complex control flow may or may not reach an unassociated terminal response.
      return facts.filter((fact) => fact.kind !== "implicit" || fact.code !== 200);
    }
  }
  return facts;
}

function combineStatuses(handlers: readonly Handler[]): StatusFact[] {
  const explicit = new Set<number>();
  const implicit = new Set<number>();
  let dynamic = false;
  for (const handler of handlers) {
    for (const fact of extractStatuses(handler)) {
      if (fact.kind === "explicit") explicit.add(fact.code);
      else if (fact.kind === "implicit") implicit.add(fact.code);
      else dynamic = true;
    }
  }
  const result: StatusFact[] = [...explicit].sort((left, right) => left - right).map((code) => ({ kind: "explicit", code }));
  result.push(...[...implicit].sort((left, right) => left - right).map((code) => ({ kind: "implicit" as const, code })));
  if (dynamic) result.push({ kind: "dynamic" });
  result.sort((left, right) => {
    if (left.kind === "dynamic") return right.kind === "dynamic" ? 0 : 1;
    if (right.kind === "dynamic") return -1;
    return left.code - right.code || left.kind.localeCompare(right.kind);
  });
  return result;
}

export function analyzeDocument(text: string, fileName: string, resolveImport?: ModuleResolver): AnalysisResult {
  const scriptKind = /\.[cm]?jsx?$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const receivers = expressBindings(source);
  const knownHandlers = handlerMap(source);
  const localHandlers = new Set([...knownHandlers.values(), ...exportedHandlerMap(source).values()]);
  const importBindings = importedHandlerBindings(source);
  const importedModules = new Map<string, Map<string, Handler> | undefined>();
  const dependencies = new Set<string>();
  const importedHandler = (name: string): Handler | undefined => {
    const binding = importBindings.get(name);
    if (!binding || !binding.moduleSpecifier.startsWith(".") || !resolveImport) return undefined;
    if (!importedModules.has(binding.moduleSpecifier)) {
      const imported: ImportedSource | undefined = resolveImport(binding.moduleSpecifier, fileName);
      if (!imported) {
        importedModules.set(binding.moduleSpecifier, undefined);
        return undefined;
      }
      dependencies.add(imported.fileName);
      const importedKind = /\.[cm]?jsx?$/i.test(imported.fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      const importedSource = ts.createSourceFile(imported.fileName, imported.text, ts.ScriptTarget.Latest, true, importedKind);
      importedModules.set(binding.moduleSpecifier, exportedHandlerMap(importedSource));
    }
    return importedModules.get(binding.moduleSpecifier)?.get(binding.exportedName);
  };
  const routes: RouteAnalysis[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const route = routeCall(node, receivers);
      if (route) {
        const handlers = handlerFunctions(node, receivers, source, knownHandlers, importedHandler);
        for (const handler of handlers) if (handler.getSourceFile() === source) localHandlers.add(handler);
        routes.push({
          ...route,
          range: { start: node.getStart(source), end: node.end },
          statuses: combineStatuses(handlers),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  routes.sort((left, right) => left.range.start - right.range.start || left.range.end - right.range.end);
  const seenLiterals = new Set<string>();
  const statusLiterals = [...localHandlers].flatMap(explicitStatusLiterals).filter(({ range }) => {
    const key = `${range.start}:${range.end}`;
    if (seenLiterals.has(key)) return false;
    seenLiterals.add(key);
    return true;
  }).sort((left, right) => left.range.start - right.range.start);
  const statusSuggestions = [...localHandlers].flatMap((handler) => statusSuggestionsForHandler(handler, source))
    .sort((left, right) => (left.range.end - left.range.start) - (right.range.end - right.range.start));
  return { routes, statusLiterals, dependencies: [...dependencies], statusSuggestions };
}

/** The current and only analyzer implementation: Express analysis for JS/TS source. */
export const expressDocumentAnalyzer: DocumentAnalyzer = {
  analyze: ({ text, fileName }, resolveImport) => analyzeDocument(text, fileName, resolveImport),
};
