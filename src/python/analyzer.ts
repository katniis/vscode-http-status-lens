import path from "node:path";
import type { AnalysisResult, CompletionContext, DocumentAnalyzer, ModuleResolver, RouteAnalysis, SourceRange, StatusFact, StatusLiteral } from "../model.js";
import { inferStatusFromContext } from "../status-suggestions.js";
import { maskPythonStrings, parseFunctions, parsePythonLines } from "./parser.js";
import type { PythonFunction, PythonLine } from "./parser.js";

const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
const maxModuleDepth = 64;
const maxModuleVisits = 64;
const empty = (): AnalysisResult => ({ routes: [], statusLiterals: [], dependencies: [], statusSuggestions: [], completionContexts: [] });

interface PythonResult extends AnalysisResult { readonly routers: ReadonlyMap<string, string>; }
interface Binding { readonly module: string; readonly name: string; }
interface ModuleBudget { readonly active: Set<string>; visits: number; }

function moduleSymbols(lines: readonly PythonLine[]) {
  const applications = new Set<string>();
  const routers = new Map<string, string>();
  const aliases = new Map<string, Binding>();
  const frameworkModules = new Set<string>();
  const moduleAliases = new Map<string, string>();
  const importedModules = new Set<string>();
  const importedConstructors = new Map<string, string>();
  const forgetBinding = (name: string) => {
    importedConstructors.delete(name);
    aliases.delete(name);
    frameworkModules.delete(name);
    moduleAliases.delete(name);
    applications.delete(name);
    routers.delete(name);
  };
  for (const { text, indent } of lines) {
    if (indent !== 0) continue;
    let match = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/.exec(text);
    if (match) {
      for (const item of (match[2] ?? "").split(",")) {
        const parts = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(item);
        if (parts?.[1]) {
          const localName = parts[2] ?? parts[1];
          forgetBinding(localName);
          aliases.set(localName, { module: match[1] ?? "", name: parts[1] });
          if (match[1] === "fastapi" && ["FastAPI", "APIRouter"].includes(parts[1])) importedConstructors.set(localName, parts[1]);
        }
      }
      continue;
    }
    const moduleImport = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(text);
    if (moduleImport) {
      const importedModule = moduleImport[1] ?? "";
      const localName = moduleImport[2] ?? importedModule.split(".")[0] ?? "";
      forgetBinding(localName);
      importedModules.add(importedModule);
      moduleAliases.set(localName, moduleImport[2] ? importedModule : importedModule.split(".")[0] ?? "");
      if (importedModule === "fastapi" || importedModule.startsWith("fastapi.")) frameworkModules.add(localName);
      continue;
    }
    match = /^\s*(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(?:([\w.]+)\.)?(\w+)\s*\((.*)\)\s*$/.exec(text);
    if (!match?.[1]) {
      const assignment = /^\s*(\w+)\s*(?::[^=]+)?=(?!=)/.exec(text);
      if (assignment?.[1]) forgetBinding(assignment[1]);
      continue;
    }
    const receiver = match[1];
    const constructor = importedConstructors.get(match[3] ?? "") ?? match[3];
    const moduleQualifier = match[2];
    const importedFromFastApi = importedConstructors.get(match[3] ?? "") === constructor;
    const qualifiedFromFastApi = moduleQualifier !== undefined && frameworkModules.has(moduleQualifier);
    const isApp = constructor === "FastAPI" && (importedFromFastApi || qualifiedFromFastApi);
    const isRouter = constructor === "APIRouter" && (importedFromFastApi || qualifiedFromFastApi);
    forgetBinding(receiver);
    if (isApp) applications.add(receiver);
    if (isRouter) routers.set(receiver, /^\s*prefix\s*=\s*(["'])(.*?)\1/.exec(match[4] ?? "")?.[2] ?? "");
  }
  return { applications, routers, aliases, frameworkModules, moduleAliases, importedModules };
}

function getResponseParameter(handler: PythonFunction, aliases: ReadonlyMap<string, Binding>, moduleAliases: ReadonlyMap<string, string>, importedModules: ReadonlySet<string>): string | undefined {
  for (const { name, annotation } of handler.parameterAnnotations) {
    const binding = aliases.get(annotation);
    if (binding && ["fastapi", "starlette.responses"].includes(binding.module) && binding.name === "Response") return name;
    const parts = annotation.split(".");
    const typeName = parts.pop();
    const qualifier = parts.join(".");
    const importedModule = moduleAliases.get(qualifier);
    if (typeName === "Response" && importedModule && ["fastapi", "fastapi.responses", "starlette.responses"].includes(importedModule)) return name;
    if (annotation === "starlette.responses.Response" && importedModules.has("starlette.responses") && moduleAliases.get("starlette") === "starlette") return name;
  }
  return undefined;
}

function functionStatus(handler: PythonFunction, aliases: ReadonlyMap<string, Binding>, responseName: string | undefined): { facts: StatusFact[]; literals: StatusLiteral[] } {
  const facts: StatusFact[] = [];
  const literals: StatusLiteral[] = [];
  const body = maskPythonStrings(handler.body);
  const responseConstructors = [...aliases]
    .filter(([, value]) => ["fastapi", "fastapi.responses", "starlette.responses"].includes(value.module) && ["Response", "JSONResponse", "PlainTextResponse", "RedirectResponse"].includes(value.name))
    .map(([name]) => name);
  const assignment = responseName
    ? new RegExp(`\\b${escapeRegex(responseName)}\\.status_code\\s*=\\s*(\\d+|[A-Za-z_]\\w*)`, "g")
    : responseConstructors.length
      ? new RegExp(`\\b(?:${responseConstructors.map(escapeRegex).join("|")})\\s*\\([^\\n)]*?\\bstatus_code\\s*=\\s*(\\d+|[A-Za-z_]\\w*)`, "g")
      : /(?!) /g;
  for (const match of body.matchAll(assignment)) {
    const value = match[1] ?? "";
    const code = Number(value);
    if (Number.isInteger(code) && code >= 100) {
      facts.push({ kind: "explicit", code });
      const start = handler.bodyStart + (match.index ?? 0) + match[0].lastIndexOf(value);
      literals.push({ code, range: { start, end: start + value.length } });
    } else facts.push({ kind: "dynamic" });
  }
  const exceptionNames = new Set([...aliases].filter(([, value]) => ["fastapi", "starlette.exceptions"].includes(value.module) && value.name === "HTTPException").map(([name]) => name));
  const exceptionPattern = new RegExp(`\\b(?:${[...exceptionNames].map(escapeRegex).join("|")})\\s*\\([^\\n)]*?\\bstatus_code\\s*=\\s*(\\d+|[A-Za-z_]\\w*)`, "g");
  for (const match of body.matchAll(exceptionPattern)) {
    const value = match[1] ?? "";
    const code = Number(value);
    if (Number.isInteger(code) && code >= 100) {
      facts.push({ kind: "explicit", code });
      const start = handler.bodyStart + (match.index ?? 0) + match[0].lastIndexOf(value);
      literals.push({ code, range: { start, end: start + value.length } });
    } else facts.push({ kind: "dynamic" });
  }
  if (facts.length === 0 && /\breturn\b/.test(handler.body)) facts.push({ kind: "implicit", code: 200 });
  return { facts: uniqueFacts(facts), literals };
}

function escapeRegex(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function uniqueFacts(facts: readonly StatusFact[]): StatusFact[] {
  return [...new Map(facts.map((fact) => [fact.kind === "dynamic" ? "dynamic" : `${fact.kind}:${fact.code}`, fact])).values()]
    .sort((left, right) => left.kind === "dynamic" ? 1 : right.kind === "dynamic" ? -1 : left.code - right.code);
}

function quoted(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(?:r|f|u|b)?(["'])(.*)\1$/i.exec(value.trim());
  return match?.[2];
}

function splitArguments(text: string): Array<{ value: string; start: number }> {
  const result: Array<{ value: string; start: number }> = [];
  let depth = 0, quote = "", start = 0;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index] ?? ",";
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    else if (char === "," && depth === 0) {
      result.push({ value: text.slice(start, index).trim(), start: text.slice(start, index).search(/\S|$/) + start });
      start = index + 1;
    }
  }
  return result;
}

function pythonModule(source: string, fileName: string, resolveImport: ModuleResolver | undefined, budget: ModuleBudget, prefix = "", range?: SourceRange, depth = 0): PythonResult {
  if (depth > maxModuleDepth || budget.visits >= maxModuleVisits || budget.active.has(fileName)) return { ...empty(), routers: new Map() };
  budget.visits++;
  budget.active.add(fileName);
  const lines = parsePythonLines(source);
  const symbols = moduleSymbols(lines);
  const functions = parseFunctions(lines, source);
  const routes: RouteAnalysis[] = [];
  const statusLiterals: StatusLiteral[] = [];
  const statusSuggestions: AnalysisResult["statusSuggestions"][number][] = [];
  const completionContexts: CompletionContext[] = [];
  const dependencies: string[] = [];
  const imports = new Map<string, Binding>(symbols.aliases);

  const routeDecorators = new Map<PythonFunction, Array<{ method: string; routePath: string; receiver: string; status?: StatusFact; statusLiteral?: StatusLiteral }>>();
  for (const fn of functions) {
    for (const decorator of fn.decorators) {
      const match = /^\s*@([A-Za-z_]\w*)\.(\w+)\s*\((.*)\)\s*$/.exec(decorator.text);
      if (!match || !methods.has(match[2] ?? "")) continue;
      const receiver = match[1] ?? "";
      if (!symbols.applications.has(receiver) && !symbols.routers.has(receiver)) continue;
      const args = match[3] ?? "";
      const parsedArgs = splitArguments(args);
      const pathArgument = parsedArgs.find(({ value }) => !/^\w+\s*=/.test(value)) ?? parsedArgs.find(({ value }) => /^path\s*=/.test(value));
      const pathArg = pathArgument?.value.replace(/^path\s*=\s*/, "");
      const routePath = quoted(pathArg) ?? "<dynamic path>";
      const configuredArgument = parsedArgs.find(({ value }) => /^status_code\s*=/.test(maskPythonStrings(value)));
      const configured = configuredArgument ? /\bstatus_code\s*=\s*(\d+|[A-Za-z_]\w*)/.exec(maskPythonStrings(configuredArgument.value)) : null;
      const code = Number(configured?.[1]);
      const status: StatusFact | undefined = configured ? Number.isInteger(code) ? { kind: "explicit", code } : { kind: "dynamic" } : undefined;
      const statusLiteral = configured && status?.kind === "explicit"
        ? { code: status.code, range: { start: decorator.start + decorator.text.indexOf(args) + (configuredArgument?.start ?? 0) + configured.index! + configured[0].lastIndexOf(configured[1] ?? ""), end: decorator.start + decorator.text.indexOf(args) + (configuredArgument?.start ?? 0) + configured.index! + configured[0].lastIndexOf(configured[1] ?? "") + (configured[1]?.length ?? 0) } }
        : undefined;
      if (statusLiteral) statusLiterals.push(statusLiteral);
      const found = routeDecorators.get(fn) ?? [];
      found.push({ method: match[2].toUpperCase(), routePath, receiver, status, statusLiteral });
      routeDecorators.set(fn, found);
    }
  }
  for (const [handler, decorators] of routeDecorators) {
    const result = functionStatus(handler, symbols.aliases, getResponseParameter(handler, symbols.aliases, symbols.moduleAliases, symbols.importedModules));
    for (const decorator of decorators) {
      const routePrefix = symbols.routers.get(decorator.receiver) ?? "";
      const facts = decorator.status ? [...result.facts.filter((fact) => fact.kind !== "implicit"), decorator.status] : result.facts;
      routes.push({ method: decorator.method, path: joinPath(prefix, routePrefix, decorator.routePath), range: range ?? { start: handler.decorators[0]?.start ?? handler.bodyStart, end: handler.bodyEnd }, statuses: uniqueFacts(facts) });
    }
  }

  for (const handler of functions) {
    const response = getResponseParameter(handler, symbols.aliases, symbols.moduleAliases, symbols.importedModules);
    const result = functionStatus(handler, symbols.aliases, response);
    statusLiterals.push(...result.literals);
    if (!response || !routeDecorators.has(handler)) continue;
    completionContexts.push({ range: { start: handler.bodyStart, end: handler.bodyEnd }, replyName: response, framework: "fastapi" });
    const bodyLines = parsePythonLines(handler.body);
    for (let index = 0; index < bodyLines.length; index++) {
      const branch = bodyLines[index];
      const condition = branch && /^\s*(if|elif|except)\b(.*):\s*$/.exec(branch.text);
      if (!branch || !condition) continue;
      const branchLines: PythonLine[] = [];
      for (let child = index + 1; child < bodyLines.length && ((bodyLines[child]?.indent ?? 0) > branch.indent || !bodyLines[child]?.text.trim()); child++) {
        const childLine = bodyLines[child];
        if (childLine && childLine.indent > branch.indent && /^\s*(?:if|elif|else|except|finally|for|while|with|try|def|async\s+def|class)\b.*:\s*$/.test(childLine.text)) break;
        if (childLine) branchLines.push(childLine);
      }
      const inferred = inferStatusFromContext(`${condition[2] ?? ""} ${branchLines.map(({ text }) => text).join(" ")}`);
      const missingLookup = /\b\w+\s+is\s+None\b/.test(condition[2] ?? "") && branchLines.some(({ text }) => /\breturn\b/.test(text));
      const suggestion = inferred ?? (missingLookup ? { code: 404, detail: "Suggested from a missing lookup result: 404 Not Found" } : undefined);
      if (suggestion) statusSuggestions.push({ code: suggestion.code, detail: suggestion.detail, range: { start: handler.bodyStart + branch.start, end: handler.bodyStart + (branchLines.at(-1)?.end ?? branch.end) } });
    }
  }

  for (const line of lines) {
    if (line.indent !== 0) continue;
    if (budget.visits >= maxModuleVisits) break;
    const include = /^\s*([A-Za-z_]\w*)\.include_router\(\s*([A-Za-z_]\w*)\s*(?:,\s*prefix\s*=\s*([^,)]+))?/.exec(line.text);
    if (!include || (!symbols.applications.has(include[1] ?? "") && !symbols.routers.has(include[1] ?? ""))) continue;
    const parentName = include[1] ?? "";
    const childName = include[2] ?? "";
    const binding = imports.get(childName);
    if (!binding || !binding.module.startsWith("." ) || !resolveImport) continue;
    const specifier = /^\.+$/.test(binding.module) ? `${binding.module}${binding.name}` : binding.module;
    const imported = resolveImport(specifier, fileName);
    if (!imported) continue;
    dependencies.push(imported.fileName);
    const childPrefix = quoted(include[3]) ?? "";
    const parentPrefix = symbols.routers.get(parentName) ?? "";
    const child = pythonModule(imported.text, imported.fileName, resolveImport, budget, joinPath(prefix, parentPrefix, childPrefix), range ?? { start: line.start, end: line.end }, depth + 1);
    routes.push(...child.routes);
    dependencies.push(...child.dependencies);
  }
  budget.active.delete(fileName);
  return { routes: routes.sort((a, b) => a.range.start - b.range.start), statusLiterals: statusLiterals.sort((a, b) => a.range.start - b.range.start), dependencies: [...new Set(dependencies)], statusSuggestions, completionContexts, routers: symbols.routers };
}

function joinPath(...parts: string[]): string {
  if (parts.at(-1) === "<dynamic path>" && parts.slice(0, -1).every((part) => !part)) return "<dynamic path>";
  const joined = parts.filter(Boolean).join("/").replace(/\/+/g, "/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

export const pythonDocumentAnalyzer: DocumentAnalyzer = {
  analyze: ({ text, fileName }, resolveImport) => {
    const result = pythonModule(text, path.resolve(fileName), resolveImport, { active: new Set(), visits: 0 });
    return { routes: result.routes, statusLiterals: result.statusLiterals, dependencies: result.dependencies, statusSuggestions: result.statusSuggestions, completionContexts: result.completionContexts };
  },
};
