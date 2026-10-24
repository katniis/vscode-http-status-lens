export interface PythonLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly indent: number;
}

export interface PythonFunction {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly parameterAnnotations: readonly { readonly name: string; readonly annotation: string }[];
  readonly decorators: readonly PythonLine[];
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly body: string;
}

function withoutComment(line: string, state: { quote: string; triple: boolean }): string {
  let quote = "";
  let triple = false;
  let masked = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (state.quote && state.triple) {
      const delimiter = state.quote.repeat(3);
      const closing = line.indexOf(delimiter, index);
      if (closing < 0) return masked;
      masked += " ".repeat(closing + 3 - index);
      index = closing + 2;
      state.quote = "";
      state.triple = false;
      continue;
    }
    if (quote) {
      masked += char;
      if (char === "\\") { index++; continue; }
      if (char === quote) {
        if (!triple || line.slice(index, index + 3) === quote.repeat(3)) {
          if (triple) index += 2;
          quote = "";
          triple = false;
        }
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      triple = line.slice(index, index + 3) === char.repeat(3);
      if (triple) {
        const closing = line.indexOf(char.repeat(3), index + 3);
        if (closing < 0) { state.quote = char; state.triple = true; return masked; }
        masked += " ".repeat(closing + 3 - index);
        index = closing + 2;
      } else masked += char;
    } else if (char === "#") return masked + line.slice(index).replace(/./g, " ");
    else masked += char;
  }
  return masked;
}

export function parsePythonLines(source: string): PythonLine[] {
  const result: PythonLine[] = [];
  let offset = 0;
  const state = { quote: "", triple: false };
  for (const raw of source.split(/(?<=\n)/)) {
    const text = withoutComment(raw.replace(/\r?\n$/, ""), state);
    const indent = /^ */.exec(text)?.[0].length ?? 0;
    result.push({ text, start: offset, end: offset + text.length, indent });
    offset += raw.length;
  }
  return result;
}

export function maskPythonStrings(source: string): string {
  const chars = source.split("");
  let quote = "", triple = false, comment = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (comment) {
      if (char === "\n") comment = false;
      else chars[index] = " ";
      continue;
    }
    if (quote) {
      if (char === "\\") { chars[index] = " "; if (index + 1 < chars.length && chars[index + 1] !== "\n") chars[++index] = " "; continue; }
      if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
        chars[index] = chars[index + 1] = chars[index + 2] = " "; index += 2; quote = ""; triple = false; continue;
      }
      if (!triple && char === quote) quote = "";
      if (char !== "\n") chars[index] = " ";
      continue;
    }
    if (char === "#") { comment = true; chars[index] = " "; continue; }
    if ((char === "'" || char === '"') && source.slice(index, index + 3) === char.repeat(3)) {
      quote = char; triple = true; chars[index] = chars[index + 1] = chars[index + 2] = " "; index += 2; continue;
    }
    if (char === "'" || char === '"') { quote = char; chars[index] = " "; }
  }
  return chars.join("");
}

export function isPythonReturnExpression(sourceBeforeCursor: string): boolean {
  const masked = maskPythonStrings(sourceBeforeCursor);
  const stack: Array<{ readonly bracket: string; readonly isReturn: boolean }> = [];
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index] ?? "";
    if ("([{".includes(char)) {
      const lineStart = masked.lastIndexOf("\n", index - 1) + 1;
      stack.push({ bracket: char, isReturn: /^\s*(?:return|yield)\b/.test(masked.slice(lineStart, index)) });
    } else if (")]}".includes(char)) {
      const matching = char === ")" ? "(" : char === "]" ? "[" : "{";
      for (let nested = stack.length - 1; nested >= 0; nested--) {
        if (stack[nested]?.bracket !== matching) continue;
        stack.length = nested;
        break;
      }
    }
  }
  return stack.some(({ isReturn }) => isReturn);
}

export function parseFunctions(lines: readonly PythonLine[], source: string): PythonFunction[] {
  const functions: PythonFunction[] = [];
  const decorators: PythonLine[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    if (line.indent === 0 && line.text.trimStart().startsWith("@")) { decorators.push(line); continue; }
    const match = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*)\)\s*(?:->[^:]+)?\s*:\s*$/.exec(line.text);
    if (!match || line.indent !== 0) { if (line.text.trim() && line.indent === 0) decorators.length = 0; continue; }
    let endIndex = index + 1;
    while (endIndex < lines.length && (!lines[endIndex]?.text.trim() || (lines[endIndex]?.indent ?? 0) > line.indent)) endIndex++;
    const bodyLines = lines.slice(index + 1, endIndex);
    const bodyStart = bodyLines.find((item) => item.text.trim())?.start ?? line.end;
    const bodyEnd = bodyLines.at(-1)?.end ?? line.end;
    const body = source.slice(bodyStart, bodyEnd);
    const maskedBody = body.split("");
    for (let nestedIndex = 0; nestedIndex < bodyLines.length; nestedIndex++) {
      const nested = bodyLines[nestedIndex];
      if (!nested || !/^\s*(?:async\s+def|def|class)\s+/.test(nested.text)) continue;
      const end = bodyLines.slice(nestedIndex + 1).find((item) => item.text.trim() && item.indent <= nested.indent)?.start ?? bodyEnd;
      for (let absolute = nested.start; absolute < end; absolute++) {
        const local = absolute - bodyStart;
        if (maskedBody[local] !== "\n" && maskedBody[local] !== "\r") maskedBody[local] = " ";
      }
    }
    const rawParameters = splitParameters(match[2] ?? "");
    const parameterAnnotations = rawParameters.flatMap((parameter) => {
      const colon = parameter.indexOf(":");
      if (colon < 0) return [];
      const name = parameter.slice(0, colon).trim();
      const annotation = parameter.slice(colon + 1).split("=")[0]?.trim() ?? "";
      return /^[A-Za-z_]\w*$/.test(name) && annotation ? [{ name, annotation }] : [];
    });
    functions.push({
      name: match[1] ?? "",
      parameters: rawParameters.map((parameter) => parameter.split(":")[0]?.split("=")[0]?.trim() ?? "").filter((parameter) => /^[A-Za-z_]\w*$/.test(parameter)),
      parameterAnnotations,
      decorators: [...decorators], bodyStart, bodyEnd,
      body: maskedBody.join(""),
    });
    decorators.length = 0;
    index = endIndex - 1;
  }
  return functions;
}

function splitParameters(text: string): string[] {
  const result: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let index = 0; index <= text.length; index++) {
    const char = text[index] ?? ",";
    if (quote) { if (char === "\\") index++; else if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') quote = char;
    else if ("([{<".includes(char)) depth++;
    else if (")]} >".replace(" ", "").includes(char)) depth--;
    else if (char === "," && depth === 0) { result.push(text.slice(start, index).trim()); start = index + 1; }
  }
  return result;
}
