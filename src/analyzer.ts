import ts from "typescript";
import type { AnalysisResult, CompletionContext, DocumentAnalyzer, ImportedSource, ModuleResolver, RouteAnalysis, SourceRange, StatusFact, StatusLiteral } from "./model.js";
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

function fastifyImportBindings(source: ts.SourceFile): Map<string, ImportedHandlerBinding> {
  const bindings = importedHandlerBindings(source);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const specifier = moduleName(declaration);
      if (specifier && ts.isIdentifier(declaration.name)) bindings.set(declaration.name.text, { moduleSpecifier: specifier, exportedName: "default" });
    }
  }
  return bindings;
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

function responseCall(node: ts.CallExpression, response: string | undefined): string | undefined {
  if (!response) return undefined;
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === response) {
    return node.expression.name.text;
  }
  return undefined;
}

function fastifyBindings(source: ts.SourceFile): Map<string, Set<ts.VariableDeclaration>> {
  const factories = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && moduleName(statement) === "fastify" && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) factories.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) factories.add(clause.namedBindings.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (moduleName(declaration) === "fastify" && ts.isIdentifier(declaration.name)) factories.add(declaration.name.text);
      }
    }
  }
  const receivers = new Map<string, Set<ts.VariableDeclaration>>();
  const bindingHasName = (binding: ts.BindingName, name: string): boolean => ts.isIdentifier(binding)
    ? binding.text === name
    : binding.elements.some((element) => !ts.isOmittedExpression(element) && bindingHasName(element.name, name));
  const nameIsShadowedAt = (name: string, call: ts.Node): boolean => {
    for (let current: ts.Node | undefined = call; current; current = current.parent) {
      const statements = ts.isBlock(current) || ts.isSourceFile(current) ? current.statements : undefined;
      if (statements?.some((statement) =>
        (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => bindingHasName(declaration.name, name))) ||
        ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name))) return true;
      if (ts.isCaseBlock(current) && current.clauses.some((clause) => clause.statements.some((statement) =>
        (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => bindingHasName(declaration.name, name))) ||
        ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name)))) return true;
      if ((ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) && current.initializer &&
        ts.isVariableDeclarationList(current.initializer) && current.initializer.declarations.some((declaration) => bindingHasName(declaration.name, name))) return true;
      if (ts.isCatchClause(current) && current.variableDeclaration && bindingHasName(current.variableDeclaration.name, name)) return true;
      if (ts.isFunctionLike(current) && current.parameters.some((parameter) => bindingHasName(parameter.name, name))) return true;
      if ((ts.isFunctionExpression(current) || ts.isClassExpression(current)) && current.name?.text === name) return true;
    }
    return false;
  };
  const factoryVisibleAt = (name: string, call: ts.CallExpression): boolean => {
    if (!factories.has(name)) return false;
    for (let current: ts.Node | undefined = call; current; current = current.parent) {
      if (ts.isBlock(current)) {
        for (const statement of current.statements) {
          if (ts.isVariableStatement(statement)) {
            const declaration = statement.declarationList.declarations.find((item) => bindingHasName(item.name, name));
            if (declaration) return moduleName(declaration) === "fastify" &&
              !(declaration.initializer && ts.isCallExpression(declaration.initializer) && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === "require" && nameIsShadowedAt("require", declaration.initializer));
          } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return false;
        }
      }
      if (ts.isCaseBlock(current) && current.clauses.some((clause) => clause.statements.some((statement) =>
        (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => bindingHasName(declaration.name, name))) ||
        ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name)))) return false;
      if ((ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) && current.initializer &&
        ts.isVariableDeclarationList(current.initializer) && current.initializer.declarations.some((declaration) => bindingHasName(declaration.name, name))) return false;
      if (ts.isCatchClause(current) && current.variableDeclaration && bindingHasName(current.variableDeclaration.name, name)) return false;
      if (ts.isFunctionLike(current) && current.parameters.some((parameter) => bindingHasName(parameter.name, name))) return false;
      if ((ts.isFunctionExpression(current) || ts.isClassExpression(current)) && current.name?.text === name) return false;
    }
    return true;
  };
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if ((ts.isIdentifier(callee) && factoryVisibleAt(callee.text, node.initializer)) ||
        (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "require" && !nameIsShadowedAt("require", callee) && stringValue(callee.arguments[0]) === "fastify")) {
        const declarations = receivers.get(node.name.text) ?? new Set<ts.VariableDeclaration>();
        declarations.add(node);
        receivers.set(node.name.text, declarations);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return receivers;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const property = object.properties.find((item) => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && item.name.getText(object.getSourceFile()).replaceAll(/["']/g, "") === name);
  if (property && ts.isPropertyAssignment(property)) return property.initializer;
  return property && ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

function stringValue(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ? expression.text : undefined;
}

function prefixedFastifyPath(prefix: string, routePathValue: string): string {
  if (routePathValue === "<dynamic path>") return routePathValue;
  if (!prefix) return routePathValue || "/";
  return `${prefix.replace(/\/$/, "")}${routePathValue.startsWith("/") ? routePathValue : `/${routePathValue}`}` || "/";
}

function combineFastifyPrefixes(prefix: string, nested: string): string {
  if (!nested) return prefix;
  const left = prefix.replace(/\/$/, "");
  const right = nested.startsWith("/") ? nested : `/${nested}`;
  return `${left}${right}` || "/";
}

function fastifyRoute(node: ts.CallExpression, receivers: ReadonlySet<string>): { method: string; path: string; handlers: ts.Expression[] } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression) || !receivers.has(node.expression.expression.text)) return undefined;
  const methodName = node.expression.name.text.toLowerCase();
  if (methodName === "route") {
    const options = node.arguments[0];
    if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
    const method = objectProperty(options, "method");
    const methods = method && ts.isArrayLiteralExpression(method)
      ? method.elements.map(stringValue).filter((item): item is string => Boolean(item))
      : [stringValue(method)].filter((item): item is string => Boolean(item));
    if (!methods.length) return undefined;
    const path = stringValue(objectProperty(options, "url")) ?? stringValue(objectProperty(options, "path")) ?? "<dynamic path>";
    const handler = objectProperty(options, "handler");
    return { method: methods.map((item) => item.toUpperCase()).join(", "), path, handlers: handler ? [handler] : [] };
  }
  if (!routeMethods.has(methodName)) return undefined;
  return { method: methodName.toUpperCase(), path: stringValue(node.arguments[0]) ?? "<dynamic path>", handlers: node.arguments.slice(1) };
}

function isReplyResponseExpression(expression: ts.Expression, reply: string): boolean {
  if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return isReplyResponseExpression(expression.expression, reply);
  }
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false;
  const receiver = expression.expression.expression;
  if (ts.isIdentifier(receiver) && receiver.text === reply && ["code", "status", "redirect", "send"].includes(expression.expression.name.text)) return true;
  return ts.isCallExpression(receiver) && isReplyResponseExpression(receiver, reply);
}

function fastifyStatusData(handler: Handler): { facts: StatusFact[]; literals: StatusLiteral[] } {
  const reply = responseName(handler);
  if (!reply || !handler.body) return { facts: [], literals: [] };
  const facts: StatusFact[] = [];
  const literals: StatusLiteral[] = [];
  function hasPrecedingStatus(node: ts.Node): boolean {
    const statement = ts.isStatement(node) ? node : node.parent;
    if (!ts.isStatement(statement) || !ts.isBlock(statement.parent)) return false;
    const siblings = statement.parent.statements;
    const previous = siblings[siblings.indexOf(statement) - 1];
    if (!previous || !ts.isExpressionStatement(previous)) return false;
    if (ts.isCallExpression(previous.expression)) return ["code", "status"].includes(responseCall(previous.expression, reply) ?? "");
    const expression = previous.expression;
    return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expression.left) && ts.isIdentifier(expression.left.expression) && expression.left.expression.text === reply && expression.left.name.text === "statusCode";
  }
  function expressionSetsReplyStatus(expression: ts.Expression): boolean {
    let found = false;
    function visitStatus(node: ts.Node): void {
      if (ts.isCallExpression(node) && ["code", "status"].includes(responseCall(node, reply) ?? "")) found = true;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) && node.left.expression.text === reply && node.left.name.text === "statusCode") found = true;
      if (node !== expression && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
      ts.forEachChild(node, visitStatus);
    }
    visitStatus(expression);
    return found;
  }
  function isReplyConfigurationExpression(expression: ts.Expression): boolean {
    const allowed = new Set(["header", "headers", "type"]);
    const methods: string[] = [];
    let current: ts.Expression = expression;
    while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      methods.push(current.expression.name.text);
      current = current.expression.expression;
    }
    return ts.isIdentifier(current) && current.text === reply && methods.length > 0 && methods.every((method) => allowed.has(method));
  }
  function hasConfiguredStatusBeforeReturn(node: ts.ReturnStatement): boolean {
    if (!ts.isBlock(node.parent)) return false;
    const siblings = node.parent.statements;
    for (let index = siblings.indexOf(node) - 1; index >= 0; index--) {
      const previous = siblings[index];
      if (ts.isVariableStatement(previous)) continue;
      if (!ts.isExpressionStatement(previous)) return false;
      const expression = previous.expression;
      if (expressionSetsReplyStatus(expression)) return true;
      if (isReplyConfigurationExpression(expression)) continue;
      return ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(expression.left) && ts.isIdentifier(expression.left.expression) && expression.left.expression.text === reply && expression.left.name.text === "statusCode";
    }
    return false;
  }
  function visit(node: ts.Node): void {
    if (node !== handler.body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression) && node.left.expression.text === reply && node.left.name.text === "statusCode") {
      const code = numericArgument(node.right);
      if (code === undefined) facts.push({ kind: "dynamic" });
      else { facts.push({ kind: "explicit", code }); literals.push({ code, range: { start: node.right.getStart(), end: node.right.end } }); }
    }
    if (ts.isCallExpression(node)) {
      const method = responseCall(node, reply);
      const arg = node.arguments[0];
      if (method === "code" || method === "status") {
        const code = numericArgument(arg);
        if (code === undefined) facts.push({ kind: "dynamic" });
        else { facts.push({ kind: "explicit", code }); if (arg) literals.push({ code, range: { start: arg.getStart(), end: arg.end } }); }
      } else if (method === "redirect") {
        const alternate = node.arguments.length > 1 && numericArgument(arg) === undefined ? node.arguments[1] : arg;
        const numeric = numericArgument(alternate);
        if (numeric !== undefined) facts.push({ kind: "explicit", code: numeric });
        else if (node.arguments.length > 1) facts.push({ kind: "dynamic" });
        else facts.push({ kind: "implicit", code: 302 });
        if (numeric !== undefined) {
          const literal = node.arguments.find((item) => numericArgument(item) === numeric);
          if (literal) literals.push({ code: numeric, range: { start: literal.getStart(), end: literal.end } });
        }
      } else if (method === "send") {
        const chained = statusCallInChain(node, reply!);
        if (!chained && !hasPrecedingStatus(node)) facts.push({ kind: "implicit", code: 200 });
      }
    }
    if (ts.isReturnStatement(node) && node.expression && !isReplyResponseExpression(node.expression, reply!) && !hasConfiguredStatusBeforeReturn(node)) facts.push({ kind: "implicit", code: 200 });
    ts.forEachChild(node, visit);
  }
  visit(handler.body);
  return { facts, literals };
}

const responseMethods = new Set(["status", "sendStatus", "code", "send", "json", "jsonp", "end", "render", "sendFile", "download", "redirect"]);

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
  if (["status", "code"].includes(responseCall(receiver, response) ?? "")) return true;
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

interface FastifyModuleResult {
  readonly routes: RouteAnalysis[];
  readonly literals: StatusLiteral[];
  readonly suggestions: StatusSuggestion[];
  readonly contexts: CompletionContext[];
  readonly dependencies: string[];
}

function unwrapFastifyPlugin(source: ts.SourceFile, expression: ts.Expression | undefined): Handler | undefined {
  if (!expression) return undefined;
  const direct = functionBody(expression);
  if (direct) return direct;
  if (ts.isIdentifier(expression)) return handlerMap(source).get(expression.text) ?? exportedHandlerMap(source).get(expression.text);
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
  const wrapper = fastifyImportBindings(source).get(expression.expression.text);
  if (wrapper?.moduleSpecifier !== "fastify-plugin") return undefined;
  return unwrapFastifyPlugin(source, expression.arguments[0]);
}

function exportedPlugin(source: ts.SourceFile, exportedName = "default"): Handler | undefined {
  const handlers = exportedHandlerMap(source);
  const standard = handlers.get(exportedName) ?? (exportedName === "default" ? handlers.get("fastifyPlugin") ?? handlers.values().next().value : undefined);
  if (standard) return standard;
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && exportedName === "default") {
      const handler = unwrapFastifyPlugin(source, statement.expression);
      if (handler) return handler;
    }
    if (ts.isVariableStatement(statement) && statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === exportedName) {
          const handler = unwrapFastifyPlugin(source, declaration.initializer);
          if (handler) return handler;
        }
      }
    }
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) || statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    const left = statement.expression.left;
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) &&
      ((left.expression.text === "module" && left.name.text === "exports") || (left.expression.text === "exports" && (exportedName === "default" || left.name.text === exportedName)))) {
      const handler = unwrapFastifyPlugin(source, statement.expression.right);
      if (handler) return handler;
    }
  }
  return undefined;
}

const MAX_FASTIFY_PLUGIN_DEPTH = 64;

function fastifyModule(source: ts.SourceFile, fileName: string, resolveImport: ModuleResolver | undefined, active: Set<string>, pluginRoot?: Handler, prefix = "", registration?: SourceRange, depth = 0): FastifyModuleResult {
  if (depth > MAX_FASTIFY_PLUGIN_DEPTH) return { routes: [], literals: [], suggestions: [], contexts: [], dependencies: [] };
  if (active.has(fileName)) return { routes: [], literals: [], suggestions: [], contexts: [], dependencies: [] };
  active.add(fileName);
  const rootReceiverDeclarations = fastifyBindings(source);
  const rootPlugin = pluginRoot ?? (!rootReceiverDeclarations.size ? exportedPlugin(source) : undefined);
  const rootReceivers = new Set(rootReceiverDeclarations.keys());
  const receivers = new Set(rootReceivers);
  const receiverPrefixes = new Map<string, string>([...receivers].map((name) => [name, prefix]));
  const receiverScopes = new Map<string, Array<{ start: number; end: number; prefix: string }>>();
  if (rootPlugin) {
    const parameter = rootPlugin.parameters[0]?.name;
    if (parameter && ts.isIdentifier(parameter) && rootPlugin.body) {
      receivers.add(parameter.text);
      receiverScopes.set(parameter.text, [{ start: rootPlugin.body.getStart(source), end: rootPlugin.body.end, prefix }]);
    }
  }
  const known = handlerMap(source);
  const exported = exportedHandlerMap(source);
  const importBindings = fastifyImportBindings(source);
  const dependencies = new Set<string>();
  const routes: RouteAnalysis[] = [];
  const literals: StatusLiteral[] = [];
  const suggestions: StatusSuggestion[] = [];
  const contexts: CompletionContext[] = [];
  const visitedHandlers = new Set<Handler>();
  const bindingContains = (binding: ts.BindingName, name: string): boolean => {
    if (ts.isIdentifier(binding)) return binding.text === name;
    return binding.elements.some((element) => !ts.isOmittedExpression(element) && bindingContains(element.name, name));
  };
  const bindingDeclarationContains = (node: ts.Node, name: string): boolean => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) return bindingContains(node.name, name);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return node.name.text === name;
    return false;
  };

  // Route registrations often appear inside plugin callbacks. Discover their first parameter before
  // collecting routes so nested callbacks in the same file stay within the same analysis pass.
  const discoveredRegistrations = new Set<ts.CallExpression>();
  const effectivePrefixes = (receiver: string, offset: number): string[] => {
    const scopes = (receiverScopes.get(receiver) ?? []).filter(({ start, end }) => offset >= start && offset <= end);
    scopes.sort((left, right) => (left.end - left.start) - (right.end - right.start));
    if (!scopes.length) return [receiverPrefixes.get(receiver) ?? prefix];
    const narrowest = scopes[0].end - scopes[0].start;
    return [...new Set(scopes.filter(({ start, end }) => end - start === narrowest).map(({ prefix: scopePrefix }) => scopePrefix))];
  };
  const receiverIsInScope = (receiver: string, offset: number, node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isBlock(current)) {
        const shadows = current.statements.some((statement) => {
          if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((declaration) => bindingDeclarationContains(declaration, receiver) && !rootReceiverDeclarations.get(receiver)?.has(declaration));
          return bindingDeclarationContains(statement, receiver);
        });
        if (shadows) return false;
      }
      if (ts.isCaseBlock(current) && current.clauses.some((clause) => clause.statements.some((statement) => {
        if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((declaration) => bindingDeclarationContains(declaration, receiver) && !rootReceiverDeclarations.get(receiver)?.has(declaration));
        return bindingDeclarationContains(statement, receiver);
      }))) return false;
      if ((ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) && current.initializer &&
        ts.isVariableDeclarationList(current.initializer) && current.initializer.declarations.some((declaration) => bindingDeclarationContains(declaration, receiver))) return false;
      if (ts.isCatchClause(current) && current.variableDeclaration && bindingDeclarationContains(current.variableDeclaration, receiver)) return false;
      if (ts.isFunctionLike(current) && current.parameters.some((parameter) => bindingContains(parameter.name, receiver))) {
        const body = "body" in current ? current.body : undefined;
        return Boolean(body && (receiverScopes.get(receiver) ?? []).some(({ start, end }) => start === body.getStart(source) && end === body.end));
      }
      if ((ts.isFunctionExpression(current) || ts.isClassExpression(current)) && current.name?.text === receiver) return false;
      if (bindingDeclarationContains(current, receiver)) return false;
    }
    if ((receiverScopes.get(receiver) ?? []).some(({ start, end }) => offset >= start && offset <= end)) return true;
    return rootReceivers.has(receiver);
  };
  let grew = true;
  while (grew) {
    grew = false;
    function discoverPlugins(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "register" &&
        ts.isIdentifier(node.expression.expression) && receivers.has(node.expression.expression.text) && receiverIsInScope(node.expression.expression.text, node.getStart(source), node) && !discoveredRegistrations.has(node)) {
        const candidate = node.arguments[0];
        const handler = candidate && (functionBody(candidate) ?? (ts.isIdentifier(candidate) ? known.get(candidate.text) ?? exported.get(candidate.text) : undefined));
        const name = handler?.parameters[0]?.name;
        if (name && ts.isIdentifier(name) && handler?.body) {
          const options = node.arguments.find((arg): arg is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(arg));
          const nested = stringValue(options && objectProperty(options, "prefix")) ?? "";
          const parentPrefixes = effectivePrefixes(node.expression.expression.text, node.getStart(source));
          discoveredRegistrations.add(node);
          receivers.add(name.text);
          const scopes = receiverScopes.get(name.text) ?? [];
          for (const parentPrefix of parentPrefixes) scopes.push({ start: handler.body.getStart(source), end: handler.body.end, prefix: combineFastifyPrefixes(parentPrefix, nested) });
          receiverScopes.set(name.text, scopes);
          grew = true;
        }
      }
      ts.forEachChild(node, discoverPlugins);
    }
    discoverPlugins(source);
  }

  const resolveHandler = (expression: ts.Expression | undefined): Handler[] => {
    if (!expression) return [];
    const inline = functionBody(expression);
    if (inline) return [inline];
    if (!ts.isIdentifier(expression)) return [];
    const local = known.get(expression.text) ?? exported.get(expression.text);
    if (local) return [local];
    const binding = importBindings.get(expression.text);
    if (!binding || !binding.moduleSpecifier.startsWith(".") || !resolveImport) return [];
    const imported = resolveImport(binding.moduleSpecifier, fileName);
    if (!imported) return [];
    dependencies.add(imported.fileName);
    const importedSource = ts.createSourceFile(imported.fileName, imported.text, ts.ScriptTarget.Latest, true, /\.[cm]?jsx?$/i.test(imported.fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const handler = exportedHandlerMap(importedSource).get(binding.exportedName);
    return handler ? [handler] : [];
  };

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const receiverName = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : undefined;
      const route = receiverName && receiverIsInScope(receiverName, node.getStart(source), node) ? fastifyRoute(node, receivers) : undefined;
      if (route) {
        const handlers = route.handlers.flatMap(resolveHandler);
        for (const handler of handlers) {
          if (handler.getSourceFile() === source && !visitedHandlers.has(handler)) {
            visitedHandlers.add(handler);
            const data = fastifyStatusData(handler);
            literals.push(...data.literals);
            suggestions.push(...statusSuggestionsForHandler(handler, source));
            const replyName = responseName(handler);
            if (replyName && handler.body) contexts.push({ range: { start: handler.body.getStart(source), end: handler.body.end }, replyName, framework: "fastify" });
          }
        }
        const facts: StatusFact[] = handlers.flatMap((handler) => fastifyStatusData(handler).facts);
        const normalized: StatusFact[] = [...new Map(facts.filter((fact): fact is Exclude<StatusFact, { kind: "dynamic" }> => fact.kind !== "dynamic").map((fact) => [`${fact.kind}:${fact.code}`, fact])).values()];
        if (facts.some((fact) => fact.kind === "dynamic")) normalized.push({ kind: "dynamic" });
        const routePrefixes = effectivePrefixes(receiverName ?? "", node.getStart(source));
        for (const routePrefix of routePrefixes) routes.push({
          method: route.method,
          path: prefixedFastifyPath(routePrefix, route.path),
          range: registration ?? { start: node.getStart(source), end: node.end },
          statuses: normalized.sort((a, b) => a.kind === "dynamic" ? 1 : b.kind === "dynamic" ? -1 : a.code - b.code),
        });
      }

      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "register" && ts.isIdentifier(node.expression.expression) && receivers.has(node.expression.expression.text)) {
        if (!receiverIsInScope(node.expression.expression.text, node.getStart(source), node)) { ts.forEachChild(node, visit); return; }
        const pluginExpression = node.arguments[0];
        const options = node.arguments.find((arg): arg is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(arg));
        const nestedPrefix = stringValue(options && objectProperty(options, "prefix")) ?? "";
        if (pluginExpression && ts.isIdentifier(pluginExpression)) {
          const binding = importBindings.get(pluginExpression.text);
          if (binding?.moduleSpecifier.startsWith(".") && resolveImport) {
            const imported = resolveImport(binding.moduleSpecifier, fileName);
            if (imported) {
              dependencies.add(imported.fileName);
              const importedSource = ts.createSourceFile(imported.fileName, imported.text, ts.ScriptTarget.Latest, true, /\.[cm]?jsx?$/i.test(imported.fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
              const plugin = exportedPlugin(importedSource, binding.exportedName);
              if (plugin) {
                for (const parentPrefix of effectivePrefixes(node.expression.expression.text, node.getStart(source))) {
                  const child = fastifyModule(importedSource, imported.fileName, resolveImport, active, plugin, combineFastifyPrefixes(parentPrefix, nestedPrefix), registration ?? { start: node.getStart(source), end: node.end }, depth + 1);
                  routes.push(...child.routes); child.dependencies.forEach((item) => dependencies.add(item));
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  if (rootPlugin?.body) visit(rootPlugin.body);
  else visit(source);
  active.delete(fileName);
  return { routes, literals, suggestions, contexts, dependencies: [...dependencies] };
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
  const expressContexts: CompletionContext[] = [...localHandlers].flatMap((handler) => {
    const replyName = responseName(handler);
    return replyName && handler.body ? [{ range: { start: handler.body.getStart(source), end: handler.body.end }, replyName, framework: "express" as const }] : [];
  });
  const fastify = fastifyModule(source, fileName, resolveImport, new Set());
  const allRoutes = [...routes, ...fastify.routes].sort((left, right) => left.range.start - right.range.start || left.range.end - right.range.end);
  const allLiterals = [...statusLiterals, ...fastify.literals].filter((item, index, array) => array.findIndex((other) => other.code === item.code && other.range.start === item.range.start && other.range.end === item.range.end) === index).sort((left, right) => left.range.start - right.range.start);
  const allSuggestions = [...statusSuggestions, ...fastify.suggestions].sort((left, right) => (left.range.end - left.range.start) - (right.range.end - right.range.start));
  return { routes: allRoutes, statusLiterals: allLiterals, dependencies: [...new Set([...dependencies, ...fastify.dependencies])], statusSuggestions: allSuggestions, completionContexts: [...expressContexts, ...fastify.contexts] };
}

/** Current and only analyzer implementation for Express and native Fastify in JS/TS. */
export const javascriptDocumentAnalyzer: DocumentAnalyzer = {
  analyze: ({ text, fileName }, resolveImport) => analyzeDocument(text, fileName, resolveImport),
};
