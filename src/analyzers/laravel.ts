import type { AnalysisResult, CompletionKind, CompletionPosition, DocumentAnalyzer, ModuleResolver, RouteAnalysis, StatusFact, StatusLiteral } from "../model.js";
import type { CompletionContext, StatusSuggestion } from "../model.js";
import { inferStatusFromContext } from "../status-suggestions.js";
import { matchingPairs, tokenizePhp } from "./php-lexer.js";
import type { PhpToken } from "./php-lexer.js";

interface Handler {
  readonly start: number;
  readonly end: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly bodyStartIndex: number;
  readonly bodyEndIndex: number;
  readonly parameterStart: number;
  readonly parameterEnd: number;
}

interface ParsedFile {
  readonly routes: RouteAnalysis[];
  readonly literals: StatusLiteral[];
  readonly suggestions: StatusSuggestion[];
  readonly contexts: CompletionContext[];
  readonly dependencies: Set<string>;
}

const routeMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "view", "redirect", "permanentredirect"]);
const responseMethods = new Set(["json", "make", "noContent", "setStatusCode"]);

function commaParts(tokens: readonly PhpToken[], pairs: ReadonlyMap<number, number>, start: number, end: number): [number, number][] {
  const result: [number, number][] = [];
  let partStart = start;
  for (let index = start; index < end; index++) {
    const value = tokens[index]?.value;
    const match = pairs.get(index);
    if (match !== undefined && match > index) { index = match; continue; }
    if (value === ",") { result.push([partStart, index]); partStart = index + 1; }
  }
  if (partStart < end) result.push([partStart, end]);
  return result;
}

function numeric(token: PhpToken | undefined): number | undefined {
  if (!token || token.kind !== "number" || !/^\d+$/.test(token.value)) return undefined;
  const value = Number(token.value);
  return Number.isSafeInteger(value) ? value : undefined;
}

function normalizePath(prefix: string, route: string): string {
  if (route === "<dynamic path>" || prefix === "<dynamic prefix>") return "<dynamic path>";
  const combined = `${prefix.replace(/\/$/, "")}/${route.replace(/^\//, "")}`;
  return combined === "" ? "/" : combined.startsWith("/") ? combined : `/${combined}`;
}

function dedupeFacts(facts: readonly StatusFact[]): StatusFact[] {
  const explicit = new Set<number>();
  const implicit = new Set<number>();
  let dynamic = false;
  for (const fact of facts) {
    if (fact.kind === "explicit") explicit.add(fact.code);
    else if (fact.kind === "implicit") implicit.add(fact.code);
    else dynamic = true;
  }
  const result: StatusFact[] = [
    ...[...explicit].sort((a, b) => a - b).map((code) => ({ kind: "explicit" as const, code })),
    ...[...implicit].sort((a, b) => a - b).map((code) => ({ kind: "implicit" as const, code })),
  ];
  if (dynamic) result.push({ kind: "dynamic" });
  return result.sort((a, b) => a.kind === "dynamic" ? 1 : b.kind === "dynamic" ? -1 : a.code - b.code || a.kind.localeCompare(b.kind));
}

function dedupeLiterals(literals: readonly StatusLiteral[]): StatusLiteral[] {
  const seen = new Set<string>();
  return literals.filter(({ code, range }) => {
    const key = `${code}:${range.start}:${range.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

class LaravelFileAnalyzer {
  private readonly tokens: PhpToken[];
  private readonly pairs: Map<number, number>;
  private readonly aliases = new Map<string, string>();
  private readonly facadeNames = new Set<string>();
  private readonly classMethods = new Map<string, Map<string, Handler>>();
  private readonly classNames = new Map<string, string>();
  private readonly currentHandlers: Handler[] = [];
  private readonly currentHandlerKeys = new Set<string>();
  private readonly result: ParsedFile = { routes: [], literals: [], suggestions: [], contexts: [], dependencies: new Set() };
  private readonly activeFiles: Set<string>;

  constructor(
    private readonly source: string,
    private readonly fileName: string,
    private readonly resolver: ModuleResolver | undefined,
    activeFiles: Set<string>,
    private readonly depth = 0,
  ) {
    this.tokens = tokenizePhp(source);
    this.pairs = matchingPairs(this.tokens);
    this.activeFiles = activeFiles;
    this.readAliases();
    this.readClasses();
    this.collectLocalHandlers();
  }

  analyze(): ParsedFile {
    this.visitRoutes(0, this.tokens.length, "", undefined);
    for (const handler of this.currentHandlers) this.collectHandler(handler, true);
    return this.result;
  }

  private value(index: number): string { return this.tokens[index]?.value ?? ""; }

  private addCurrentHandler(handler: Handler): void {
    const key = `${handler.start}:${handler.end}`;
    if (this.currentHandlerKeys.has(key)) return;
    this.currentHandlerKeys.add(key);
    this.currentHandlers.push(handler);
  }

  private readAliases(): void {
    for (let index = 0; index < this.tokens.length; index++) {
      if (this.value(index) !== "use" || this.value(index + 1) === "(" || this.value(index + 1) === "function" || this.value(index + 1) === "const") continue;
      let end = index + 1;
      while (end < this.tokens.length && this.value(end) !== ";") end++;
      const parts = this.tokens.slice(index + 1, end);
      if (!parts.length || parts.some((token) => token.value === "{" || token.value === "}")) continue;
      const asIndex = parts.findIndex((token) => token.value.toLowerCase() === "as");
      const fullName = parts.slice(0, asIndex < 0 ? parts.length : asIndex).map(({ value }) => value).join("").replace(/^\\/, "");
      const alias = asIndex < 0 ? fullName.split("\\").at(-1) : parts[asIndex + 1]?.value;
      if (!fullName || !alias) continue;
      if (fullName === "Illuminate\\Support\\Facades\\Route") this.facadeNames.add(alias);
      if (asIndex >= 0 || !this.aliases.has(alias)) this.aliases.set(alias, fullName);
      index = end;
    }
  }

  private namespaceName(): string {
    for (let index = 0; index < this.tokens.length; index++) {
      if (this.value(index) === "namespace") {
        let end = index + 1;
        while (end < this.tokens.length && this.value(end) !== ";" && this.value(end) !== "{") end++;
        return this.tokens.slice(index + 1, end).map(({ value }) => value).join("").replace(/^\\|\\$/g, "");
      }
    }
    return "";
  }

  private readClasses(): void {
    const namespace = this.namespaceName();
    for (let index = 0; index < this.tokens.length; index++) {
      if (this.value(index) !== "class" || this.tokens[index + 1]?.kind !== "identifier") continue;
      const name = this.value(index + 1);
      let body = index + 2;
      while (body < this.tokens.length && this.value(body) !== "{") body++;
      const close = this.pairs.get(body);
      if (close === undefined) continue;
      const qualified = namespace ? `${namespace}\\${name}` : name;
      const methods = new Map<string, Handler>();
      for (let method = body + 1; method < close; method++) {
        if (this.value(method) !== "function") continue;
        const handler = this.handlerAt(method, close);
        if (!handler) continue;
        let nameIndex = method + 1;
        while (nameIndex < handler.parameterStart && this.value(nameIndex) !== "(" && this.tokens[nameIndex]?.kind !== "identifier") nameIndex++;
        while (nameIndex < handler.parameterStart && this.tokens[nameIndex]?.kind !== "identifier") nameIndex++;
        const methodName = this.value(nameIndex).replace(/^&/, "");
        if (methodName) methods.set(methodName, handler);
        this.addCurrentHandler(handler);
        method = handler.bodyEndIndex;
      }
      this.classNames.set(name, qualified);
      this.classMethods.set(qualified, methods);
      index = close;
    }
  }

  private collectLocalHandlers(): void {
    for (let index = 0; index < this.tokens.length; index++) {
      const value = this.value(index);
      if (value === "function" || value === "fn") {
        const handler = this.handlerAt(index, this.tokens.length);
        if (handler) {
          this.addCurrentHandler(handler);
          index = handler.bodyEndIndex;
        }
      }
    }
  }

  private handlerAt(start: number, limit: number): Handler | undefined {
    const isArrow = this.value(start) === "fn";
    let open = start + 1;
    while (open < limit && this.value(open) !== "(" && this.value(open) !== "{" && this.value(open) !== ";") open++;
    if (this.value(open) !== "(") return undefined;
    const closeParams = this.pairs.get(open);
    if (closeParams === undefined) return undefined;
    if (!isArrow) {
      let body = closeParams + 1;
      while (body < limit && this.value(body) !== "{" && this.value(body) !== ";") body++;
      const closeBody = this.pairs.get(body);
      if (this.value(body) !== "{" || closeBody === undefined) return undefined;
      return {
        start: this.tokens[start]?.start ?? 0,
        end: this.tokens[closeBody]?.end ?? 0,
        bodyStart: this.tokens[body]?.start ?? 0,
        bodyEnd: this.tokens[closeBody]?.end ?? 0,
        bodyStartIndex: body,
        bodyEndIndex: closeBody,
        parameterStart: open + 1,
        parameterEnd: closeParams,
      };
    }
    let arrow = closeParams + 1;
    while (arrow < limit && this.value(arrow) !== "=>" && this.value(arrow) !== ";" && this.value(arrow) !== ",") arrow++;
    if (this.value(arrow) !== "=>") return undefined;
    let end = arrow + 1;
    while (end < limit && ![",", ";", ")", "]", "}"].includes(this.value(end))) {
      const close = this.pairs.get(end);
      if (close !== undefined && close > end) end = close;
      end++;
    }
    const last = this.tokens[Math.max(arrow + 1, end - 1)];
    return {
      start: this.tokens[start]?.start ?? 0,
      end: last?.end ?? 0,
      bodyStart: this.tokens[arrow + 1]?.start ?? 0,
      bodyEnd: last?.end ?? 0,
      bodyStartIndex: arrow + 1,
      bodyEndIndex: Math.max(arrow + 1, end - 1),
      parameterStart: open + 1,
      parameterEnd: closeParams,
    };
  }

  private routeAlias(index: number): boolean {
    const name = this.value(index).replace(/^\\/, "");
    return this.facadeNames.has(name) || name === "Illuminate\\Support\\Facades\\Route";
  }

  private staticCall(index: number): boolean {
    return this.tokens[index]?.kind === "identifier" && this.value(index + 1) === "::";
  }

  private callClose(open: number): number | undefined { return this.pairs.get(open); }

  private staticString(start: number, end: number): string | undefined {
    const token = this.tokens[start];
    return start + 1 === end && token?.kind === "string" ? token.value : undefined;
  }

  private classReference(start: number, end: number): string | undefined {
    if (this.value(start) === "[" && this.pairs.get(start) === end - 1) [start, end] = [start + 1, end - 1];
    let className = "";
    for (let index = start; index < end; index++) {
      if (this.value(index) === "::" && this.value(index + 1) === "class") {
        className = this.value(index - 1).replace(/^\\/, "");
        break;
      }
    }
    if (!className) return undefined;
    return this.classNames.get(className) ?? this.aliases.get(className) ?? className;
  }

  private routeGroup(index: number): { close: number; prefix: string; controller?: string; callback?: Handler } | undefined {
    if (!this.staticCall(index) || !this.routeAlias(index)) return undefined;
    const chainStart = index + 2;
    const open = chainStart + 1;
    if (this.value(open) !== "(") return undefined;
    const close = this.callClose(open);
    if (close === undefined) return undefined;
    let cursor = close + 1;
    let prefix = "";
    let controller: string | undefined;
    let groupOpen: number | undefined;
    let groupClose: number | undefined;
    const groupIsDirect = this.value(chainStart) === "group";
    let directGroupArgs: [number, number][] = [];
    const initialArgs = commaParts(this.tokens, this.pairs, open + 1, close);
    if (this.value(chainStart) === "prefix" && initialArgs[0]) prefix = this.staticString(...initialArgs[0]) ?? "<dynamic prefix>";
    if (this.value(chainStart) === "controller" && initialArgs[0]) controller = this.classReference(...initialArgs[0]);
    if (groupIsDirect) { groupOpen = open; groupClose = close; directGroupArgs = initialArgs; }
    while (this.value(cursor) === "->") {
      const method = this.value(cursor + 1);
      const argsOpen = cursor + 2;
      if (this.value(argsOpen) !== "(") break;
      const argsClose = this.callClose(argsOpen);
      if (argsClose === undefined) break;
      const args = commaParts(this.tokens, this.pairs, argsOpen + 1, argsClose);
      if (method === "prefix" && args[0]) prefix = this.staticString(...args[0]) ?? "<dynamic prefix>";
      if (method === "controller" && args[0]) controller = this.classReference(...args[0]);
      if (method === "group") { groupOpen = argsOpen; groupClose = argsClose; }
      cursor = argsClose + 1;
    }
    if (groupOpen === undefined || groupClose === undefined) return undefined;
    const groupArgs = groupIsDirect ? directGroupArgs : commaParts(this.tokens, this.pairs, groupOpen + 1, groupClose);
    if (groupIsDirect && groupArgs[0]) {
      const [start, end] = groupArgs[0];
      if (this.value(start) === "[" && this.pairs.get(start) === end - 1) {
        for (const [keyStart, keyEnd] of commaParts(this.tokens, this.pairs, start + 1, end - 1)) {
          const key = this.tokens[keyStart];
          let valueStart = keyStart;
          while (valueStart < keyEnd && this.value(valueStart) !== "=>") valueStart++;
          valueStart++;
          const valueEnd = keyEnd;
          if (key?.kind === "string" && key.value === "prefix") prefix = this.staticString(valueStart, valueEnd) ?? "<dynamic prefix>";
          if (key?.kind === "string" && key.value === "controller") controller = this.classReference(valueStart, valueEnd);
        }
      }
    }
    let callback: Handler | undefined;
    for (const [argStart, argEnd] of groupArgs) {
      for (let candidate = argStart; candidate < argEnd; candidate++) {
        if (this.value(candidate) === "function" || this.value(candidate) === "fn") {
          callback = this.handlerAt(candidate, argEnd);
          if (callback) break;
        }
      }
      if (callback) break;
    }
    return callback ? { close: groupClose, prefix, controller, callback } : undefined;
  }

  private routeCall(index: number): { close: number; route: RouteAnalysis; handlers: Handler[]; literals: StatusLiteral[]; unresolved: boolean } | undefined {
    if (!this.staticCall(index) || !this.routeAlias(index)) return undefined;
    const method = this.value(index + 2).toLowerCase();
    if (!routeMethods.has(method) && method !== "any" && method !== "match") return undefined;
    const open = index + 3;
    if (this.value(open) !== "(") return undefined;
    const close = this.callClose(open);
    if (close === undefined) return undefined;
    const args = commaParts(this.tokens, this.pairs, open + 1, close);
    let pathPart: [number, number] | undefined;
    let actionPart: [number, number] | undefined;
    const shortcutFacts: StatusFact[] = [];
    const shortcutLiterals: StatusLiteral[] = [];
    let methods = [method.toUpperCase()];
    if (method === "match") {
      const verbs = args[0];
      pathPart = args[1];
      actionPart = args[2];
      methods = [];
      if (verbs && this.value(verbs[0]) === "[") {
        const arrayClose = this.pairs.get(verbs[0]) ?? verbs[1];
        for (const [verbStart, verbEnd] of commaParts(this.tokens, this.pairs, verbs[0] + 1, arrayClose)) {
          const verb = this.staticString(verbStart, verbEnd);
          if (verb) methods.push(verb.toUpperCase());
        }
      }
    } else {
      pathPart = args[0];
      actionPart = ["view", "redirect", "permanentredirect"].includes(method) ? undefined : args[1];
      if (method === "any") methods = ["ANY"];
      if (method === "view" || method === "redirect" || method === "permanentredirect") methods = ["GET"];
      if (method === "view") {
        const status = args[3];
        const statusToken = status && this.tokens[status[0]];
        const code = numeric(statusToken);
        if (!status) shortcutFacts.push({ kind: "implicit", code: 200 });
        else if (code !== undefined && statusToken) {
          shortcutFacts.push({ kind: "explicit", code });
          shortcutLiterals.push({ code, range: { start: statusToken.start, end: statusToken.end } });
        } else shortcutFacts.push({ kind: "dynamic" });
      }
      if (method === "permanentredirect") shortcutFacts.push({ kind: "implicit", code: 301 });
      if (method === "redirect") {
        const status = args[2];
        const statusToken = status && this.tokens[status[0]];
        const code = numeric(statusToken);
        if (!status) shortcutFacts.push({ kind: "implicit", code: 302 });
        else if (code !== undefined && statusToken) {
          shortcutFacts.push({ kind: "explicit", code });
          shortcutLiterals.push({ code, range: { start: statusToken.start, end: statusToken.end } });
        } else shortcutFacts.push({ kind: "dynamic" });
      }
    }
    if (!methods.length) return undefined;
    if (!pathPart) return undefined;
    const path = this.staticString(...pathPart) ?? "<dynamic path>";
    const handlers: Handler[] = [];
    const controllerFacts: StatusFact[] = [];
    let unresolved = false;
    if (actionPart) {
      for (let candidate = actionPart[0]; candidate < actionPart[1]; candidate++) {
        if (this.value(candidate) === "function" || this.value(candidate) === "fn") {
          const handler = this.handlerAt(candidate, actionPart[1]);
          if (handler) handlers.push(handler);
          break;
        }
      }
      if (!handlers.length) {
        const className = this.classReference(...actionPart);
        const strings = this.tokens.slice(actionPart[0], actionPart[1]).filter(({ kind }) => kind === "string");
        const actionMethod = strings.at(-1)?.value;
        const stringAction = strings.length === 1 ? strings[0]?.value.split("@") : undefined;
        const actionClass = className ?? (strings.length > 1 ? strings[0]?.value : stringAction?.length === 2 ? this.aliases.get(stringAction[0] ?? "") ?? stringAction[0] : undefined);
        const controllerName = actionClass ?? this.currentController;
        const methodName = stringAction?.length === 2 ? stringAction[1] : actionClass ? actionMethod : strings[0]?.value;
        if (controllerName && methodName) {
          const resolved = this.resolveControllerMethod(controllerName, methodName);
          if (resolved) {
            controllerFacts.push(...resolved.analyzer.handlerStatuses(resolved.handler).facts);
            if (resolved.fileName === this.fileName) handlers.push(resolved.handler);
          }
          else unresolved = true;
        }
      }
    }
    const facts = [...shortcutFacts, ...controllerFacts, ...handlers.flatMap((handler) => this.handlerStatuses(handler).facts)];
    return {
      close,
      unresolved,
      handlers,
      literals: shortcutLiterals,
      route: {
        method: methods.join(", "),
        path,
        range: { start: this.tokens[index]?.start ?? 0, end: this.tokens[close]?.end ?? 0 },
        statuses: dedupeFacts(facts),
      },
    };
  }

  private currentController?: string;

  private resolveControllerMethod(className: string, method: string): { handler: Handler; fileName: string; analyzer: LaravelFileAnalyzer } | undefined {
    const methods = this.classMethods.get(className);
    const local = methods?.get(method);
    if (local) return { handler: local, fileName: this.fileName, analyzer: this };
    if (!this.resolver || this.depth >= 64 || this.activeFiles.has(this.fileName)) return undefined;
    const imported = this.resolver(className, this.fileName);
    if (!imported || this.activeFiles.has(imported.fileName)) return undefined;
    this.result.dependencies.add(imported.fileName);
    this.activeFiles.add(this.fileName);
    const file = new LaravelFileAnalyzer(imported.text, imported.fileName, this.resolver, this.activeFiles, this.depth + 1);
    const resolved = file.classMethods.get(className)?.get(method);
    this.activeFiles.delete(this.fileName);
    if (!resolved) return undefined;
    return { handler: resolved, fileName: imported.fileName, analyzer: file };
  }

  private collectHandler(handler: Handler, includeContext: boolean): void {
    const data = this.handlerStatuses(handler);
    this.result.literals.push(...data.literals);
    this.result.suggestions.push(...this.handlerSuggestions(handler));
    if (includeContext) this.result.contexts.push({
      range: { start: handler.bodyStart, end: handler.bodyEnd },
      replyName: this.responseParameter(handler),
      framework: "laravel",
      language: "php",
    });
  }

  private responseParameter(handler: Handler): string {
    for (const [start, end] of commaParts(this.tokens, this.pairs, handler.parameterStart, handler.parameterEnd)) {
      let variable: PhpToken | undefined;
      let variableIndex = start;
      for (; variableIndex < end; variableIndex++) {
        if (this.tokens[variableIndex]?.kind === "variable") {
          variable = this.tokens[variableIndex];
          break;
        }
      }
      if (!variable) continue;
      const typeTokens = this.tokens.slice(start, variableIndex);
      const type = typeTokens.map(({ value }) => value).join("").replace(/^\?/, "").replace(/^\\/, "");
      const typeName = type.split("\\").at(-1) ?? "";
      const fullType = this.aliases.get(typeName) ?? type;
      if (/^(?:\\?Illuminate\\Http\\Response|\\?Symfony\\Component\\HttpFoundation\\Response)$/.test(fullType)) return variable.value;
    }
    return "";
  }

  private handlerStatuses(handler: Handler): { facts: StatusFact[]; literals: StatusLiteral[] } {
    const facts: StatusFact[] = [];
    const literals: StatusLiteral[] = [];
    for (let index = handler.bodyStartIndex; index <= handler.bodyEndIndex; index++) {
      const token = this.tokens[index];
      if (!token) continue;
      if (index > handler.bodyStartIndex && (token.value === "function" || token.value === "fn")) {
        const nested = this.handlerAt(index, handler.bodyEndIndex + 1);
        if (nested) { index = nested.bodyEndIndex; continue; }
      }
      if (token.value === "abort" && this.value(index + 1) === "(") {
        const open = index + 1;
        const close = this.pairs.get(open);
        const arg = close === undefined ? undefined : commaParts(this.tokens, this.pairs, open + 1, close)[0];
        const codeToken = arg && this.tokens[arg[0]];
        const code = numeric(codeToken);
        if (code !== undefined && codeToken) { facts.push({ kind: "explicit", code }); literals.push({ code, range: { start: codeToken.start, end: codeToken.end } }); }
        else facts.push({ kind: "dynamic" });
      }
      if ((token.value === "abort_if" || token.value === "abort_unless") && this.value(index + 1) === "(") {
        const open = index + 1;
        const close = this.pairs.get(open);
        const statusArg = close === undefined ? undefined : commaParts(this.tokens, this.pairs, open + 1, close)[1];
        const codeToken = statusArg && this.tokens[statusArg[0]];
        const code = numeric(codeToken);
        if (code !== undefined && codeToken) { facts.push({ kind: "explicit", code }); literals.push({ code, range: { start: codeToken.start, end: codeToken.end } }); }
        else facts.push({ kind: "dynamic" });
      }
      if (token.value === "redirect" && this.value(index + 1) === "(") {
        const open = index + 1;
        const close = this.pairs.get(open);
        const statusArg = close === undefined ? undefined : commaParts(this.tokens, this.pairs, open + 1, close)[1];
        const codeToken = statusArg && this.tokens[statusArg[0]];
        const code = numeric(codeToken);
        if (statusArg && code !== undefined && codeToken) { facts.push({ kind: "explicit", code }); literals.push({ code, range: { start: codeToken.start, end: codeToken.end } }); }
        else if (statusArg) facts.push({ kind: "dynamic" });
      }
      if (token.value === "->" && responseMethods.has(this.value(index + 1)) && this.value(index + 2) === "(") {
        const method = this.value(index + 1);
        const open = index + 2;
        const close = this.pairs.get(open);
        if (close === undefined) continue;
        const args = commaParts(this.tokens, this.pairs, open + 1, close);
        const statusIndex = method === "noContent" || method === "setStatusCode" ? 0 : 1;
        const arg = args[statusIndex];
        if (method === "noContent" && !arg) facts.push({ kind: "implicit", code: 204 });
        else if (arg) {
          const codeToken = this.tokens[arg[0]];
          const code = numeric(codeToken);
          if (code !== undefined && codeToken) { facts.push({ kind: "explicit", code }); literals.push({ code, range: { start: codeToken.start, end: codeToken.end } }); }
          else facts.push({ kind: "dynamic" });
        }
      }
      if (token.value === "response" && this.value(index + 1) === "(") {
        const close = this.pairs.get(index + 1);
        const args = close === undefined ? [] : commaParts(this.tokens, this.pairs, index + 2, close);
        const statusArg = args[1];
        if (statusArg) {
          const codeToken = this.tokens[statusArg[0]];
          const code = numeric(codeToken);
          if (code !== undefined && codeToken) { facts.push({ kind: "explicit", code }); literals.push({ code, range: { start: codeToken.start, end: codeToken.end } }); }
          else facts.push({ kind: "dynamic" });
        }
      }
      if (token.value === "return") {
        let end = index + 1;
        while (end <= handler.bodyEndIndex && this.value(end) !== ";") {
          const close = this.pairs.get(end);
          if (close !== undefined && close > end) end = close;
          end++;
        }
        const returnedTokens = this.tokens.slice(index + 1, end);
        const returned = returnedTokens.map(({ value }) => value).join("");
        const responseMethodIndex = returnedTokens.findIndex((item, offset) => item.value === "->" && ["json", "make", "setStatusCode", "noContent"].includes(returnedTokens[offset + 1]?.value ?? ""));
        const methodName = responseMethodIndex < 0 ? "" : returnedTokens[responseMethodIndex + 1]?.value ?? "";
        const methodOpen = responseMethodIndex < 0 ? -1 : index + 1 + responseMethodIndex + 2;
        const methodArgs = methodOpen >= 0 && this.value(methodOpen) === "("
          ? commaParts(this.tokens, this.pairs, methodOpen + 1, this.pairs.get(methodOpen) ?? methodOpen)
          : [];
        const directResponse = responseMethodIndex < 0 && returnedTokens[0]?.value === "response" && returnedTokens[1]?.value === "(";
        const directOpen = directResponse ? index + 2 : -1;
        const directArgs = directOpen >= 0 && this.value(directOpen) === "("
          ? commaParts(this.tokens, this.pairs, directOpen + 1, this.pairs.get(directOpen) ?? directOpen)
          : [];
        const redirectIndex = returnedTokens.findIndex((item, offset) => item.value === "redirect" && returnedTokens[offset + 1]?.value === "(");
        const redirectOpen = redirectIndex < 0 ? -1 : index + 1 + redirectIndex + 1;
        const redirectArgs = redirectOpen >= 0 && this.value(redirectOpen) === "("
          ? commaParts(this.tokens, this.pairs, redirectOpen + 1, this.pairs.get(redirectOpen) ?? redirectOpen)
          : [];
        if (/^(?:redirect|back)\(/.test(returned) && !redirectArgs[1]) facts.push({ kind: "implicit", code: 302 });
        else if (methodName === "noContent" && !methodArgs[0]) facts.push({ kind: "implicit", code: 204 });
        else if (["json", "make", "setStatusCode"].includes(methodName) && !methodArgs[1]) facts.push({ kind: "implicit", code: 200 });
        else if (directResponse && !directArgs[1]) facts.push({ kind: "implicit", code: 200 });
        else if (/^view\(/.test(returned)) facts.push({ kind: "implicit", code: 200 });
      }
    }
    if (this.value(handler.bodyStartIndex) !== "{" && facts.length === 0) {
      const expression = this.source.slice(handler.bodyStart, handler.bodyEnd);
      if (/^\s*(?:response\(\)->(?:json|make)\(|response\(|view\()/.test(expression)) facts.push({ kind: "implicit", code: 200 });
      else if (/^\s*response\(\)->noContent\(/.test(expression)) facts.push({ kind: "implicit", code: 204 });
      else if (/^\s*(?:redirect|back)\(/.test(expression)) facts.push({ kind: "implicit", code: 302 });
    }
    return { facts: dedupeFacts(facts), literals };
  }

  private handlerSuggestions(handler: Handler): StatusSuggestion[] {
    const result: StatusSuggestion[] = [];
    for (let index = handler.bodyStartIndex; index <= handler.bodyEndIndex; index++) {
      if (index > handler.bodyStartIndex && (this.value(index) === "function" || this.value(index) === "fn")) {
        const nested = this.handlerAt(index, handler.bodyEndIndex + 1);
        if (nested) { index = nested.bodyEndIndex; continue; }
      }
      if (this.value(index) !== "if" || this.value(index + 1) !== "(") continue;
      const conditionEnd = this.pairs.get(index + 1);
      if (conditionEnd === undefined) continue;
      const bodyStart = conditionEnd + 1;
      let bodyEnd = bodyStart;
      if (this.value(bodyStart) === "{") bodyEnd = this.pairs.get(bodyStart) ?? bodyStart;
      else while (bodyEnd <= handler.bodyEndIndex && this.value(bodyEnd) !== ";") bodyEnd++;
      const context = this.source.slice(this.tokens[index]?.start ?? 0, this.tokens[bodyEnd]?.end ?? 0);
      const inferred = inferStatusFromContext(context);
      if (inferred) result.push({ code: inferred.code, detail: inferred.detail, range: { start: this.tokens[bodyStart]?.start ?? 0, end: this.tokens[bodyEnd]?.end ?? 0 } });
      index = bodyEnd;
    }
    return result;
  }

  private visitRoutes(start: number, end: number, prefix: string, controller?: string): void {
    const previousController = this.currentController;
    this.currentController = controller ?? previousController;
    for (let index = start; index < end; index++) {
      if (!this.staticCall(index) || !this.routeAlias(index)) continue;
      const group = this.routeGroup(index);
      if (group?.callback && group.close < end) {
        const combinedPrefix = group.prefix === "<dynamic prefix>" ? group.prefix : normalizePath(prefix, group.prefix);
        this.visitRoutes(group.callback.bodyStartIndex, group.callback.bodyEndIndex, combinedPrefix, group.controller ?? controller);
        index = group.close;
        continue;
      }
      const route = this.routeCall(index);
      if (route) {
        if (!route.unresolved) {
          this.result.routes.push({ ...route.route, path: normalizePath(prefix, route.route.path) });
          this.result.literals.push(...route.literals);
        }
        for (const handler of route.handlers) this.addCurrentHandler(handler);
        index = route.close;
      }
    }
    this.currentController = previousController;
  }
}

function analyzeFile(text: string, fileName: string, resolveImport?: ModuleResolver, active = new Set<string>()): AnalysisResult {
  const parsed = new LaravelFileAnalyzer(text, fileName, resolveImport, active).analyze();
  const routes = parsed.routes.sort((left, right) => left.range.start - right.range.start);
  const literals = dedupeLiterals(parsed.literals).sort((left, right) => left.range.start - right.range.start);
  const suggestions = parsed.suggestions.sort((left, right) => (left.range.end - left.range.start) - (right.range.end - right.range.start));
  return { routes, statusLiterals: literals, statusSuggestions: suggestions, completionContexts: parsed.contexts, dependencies: [...parsed.dependencies] };
}

export function analyzeLaravelDocument(text: string, fileName: string, resolveImport?: ModuleResolver): AnalysisResult {
  return analyzeFile(text, fileName, resolveImport);
}

export const laravelDocumentAnalyzer: DocumentAnalyzer = {
  analyze: ({ text, fileName }, resolveImport) => analyzeLaravelDocument(text, fileName, resolveImport),
  completionPosition: (prefix: string): CompletionPosition => {
    const previous = tokenizePhp(prefix).at(-1)?.value;
    return {
      returning: previous === "return",
      statementPosition: !previous || [";", "{", "}"].includes(previous),
    };
  },
  insertCompletion: (kind: CompletionKind, code: number, context) => {
    const prefix = context.statementPosition && !context.returning ? "return " : "";
    const response = context.replyName
      ? `$${context.replyName}->setStatusCode(${code})${kind === "sendStatus" ? "->send()" : ""}`
      : kind === "status" ? `response()->json([], ${code})` : `response()->noContent(${code})`;
    return `${prefix}${response}`;
  },
};
