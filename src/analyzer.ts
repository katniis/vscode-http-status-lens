import ts from "typescript";
import type { AnalysisResult, RouteAnalysis } from "./model.js";

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

function routePath(expression: ts.Expression, receivers: ReadonlySet<string>, source: ts.SourceFile): ts.Expression | undefined {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
  const property = expression.expression;
  if (property.name.text === "route" && ts.isIdentifier(property.expression) && receivers.has(property.expression.text)) return expression.arguments[0];
  return routePath(property.expression, receivers, source);
}

function pathText(path: ts.Expression | undefined): string {
  if (!path) return "<dynamic path>";
  if (ts.isStringLiteralLike(path)) return path.text;
  if (ts.isNoSubstitutionTemplateLiteral(path)) return path.text;
  return "<dynamic path>";
}

function routeCall(node: ts.CallExpression, receivers: ReadonlySet<string>, source: ts.SourceFile): { method: string; path: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const { expression, name } = node.expression;
  const method = name.text.toLowerCase();
  if (!routeMethods.has(method)) return undefined;

  if (ts.isIdentifier(expression) && receivers.has(expression.text)) {
    return { method: method.toUpperCase(), path: pathText(node.arguments[0]) };
  }
  const path = routePath(expression, receivers, source);
  return path ? { method: method.toUpperCase(), path: pathText(path) } : undefined;
}

export function analyzeDocument(text: string, fileName: string): AnalysisResult {
  const scriptKind = /\.[cm]?jsx?$/i.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const receivers = expressBindings(source);
  const routes: RouteAnalysis[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const route = routeCall(node, receivers, source);
      if (route) routes.push({
        ...route,
        range: { start: node.getStart(source), end: node.end },
        statuses: [],
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  routes.sort((left, right) => left.range.start - right.range.start || left.range.end - right.range.end);
  return { routes };
}
