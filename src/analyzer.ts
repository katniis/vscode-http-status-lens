import ts from "typescript";
import type { AnalysisResult, RouteAnalysis, SourceRange, StatusFact } from "./model.js";

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

function handlerFunctions(node: ts.CallExpression, receivers: ReadonlySet<string>, source: ts.SourceFile, known: ReadonlyMap<string, Handler>): Handler[] {
  if (!ts.isPropertyAccessExpression(node.expression)) return [];
  const receiver = node.expression.expression;
  const directRoute = ts.isIdentifier(receiver) && receivers.has(receiver.text);
  const args = directRoute ? node.arguments.slice(1) : node.arguments;
  const result: Handler[] = [];
  for (const argument of args) {
    const inline = functionBody(argument);
    if (inline) result.push(inline);
    else if (ts.isIdentifier(argument)) {
      const resolved = known.get(argument.text);
      if (resolved) result.push(resolved);
    }
  }
  return result;
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
        if (code !== undefined && argument) facts.push({ kind: "explicit", code, range: { start: argument.getStart(), end: argument.end } });
        else facts.push({ kind: "dynamic" });
      } else if (method === "redirect") {
        const first = node.arguments[0];
        if (node.arguments.length > 1) {
          const code = numericArgument(first);
          if (code !== undefined && first) facts.push({ kind: "explicit", code, range: { start: first.getStart(), end: first.end } });
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
  const explicit = new Map<number, SourceRange[]>();
  const implicit = new Set<number>();
  let dynamic = false;
  for (const handler of handlers) {
    for (const fact of extractStatuses(handler)) {
      if (fact.kind === "explicit") explicit.set(fact.code, [...(explicit.get(fact.code) ?? []), ...(fact.ranges ?? [fact.range])]);
      else if (fact.kind === "implicit") implicit.add(fact.code);
      else dynamic = true;
    }
  }
  const result: StatusFact[] = [...explicit]
    .sort(([left], [right]) => left - right)
    .map(([code, ranges]) => ({ kind: "explicit", code, range: ranges[0] as SourceRange, ranges }));
  result.push(...[...implicit].sort((left, right) => left - right).map((code) => ({ kind: "implicit" as const, code })));
  if (dynamic) result.push({ kind: "dynamic" });
  result.sort((left, right) => {
    if (left.kind === "dynamic") return right.kind === "dynamic" ? 0 : 1;
    if (right.kind === "dynamic") return -1;
    return left.code - right.code || left.kind.localeCompare(right.kind);
  });
  return result;
}

export function analyzeDocument(text: string, fileName: string): AnalysisResult {
  const scriptKind = /\.[cm]?jsx?$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const receivers = expressBindings(source);
  const knownHandlers = handlerMap(source);
  const routes: RouteAnalysis[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const route = routeCall(node, receivers);
      if (route) {
        const handlers = handlerFunctions(node, receivers, source, knownHandlers);
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
  return { routes };
}
