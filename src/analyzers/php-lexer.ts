export interface PhpToken {
  readonly kind: "identifier" | "variable" | "number" | "string" | "symbol";
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const operators = ["?->", "::", "->", "=>", "...", "??", "==", "===", "!=", "!==", "<=", ">=", "&&", "||"];

/** Tokenizes PHP source without interpreting comments or quoted route text as code. */
export function tokenizePhp(source: string): PhpToken[] {
  const tokens: PhpToken[] = [];
  let index = 0;
  let inPhp = !source.includes("<?");
  while (index < source.length) {
    const start = index;
    const char = source[index] ?? "";
    if (!inPhp) {
      const openTag = source.indexOf("<?", index);
      if (openTag < 0) break;
      index = openTag;
      inPhp = true;
      continue;
    }
    if (/\s/.test(char)) { index++; continue; }
    if (source.startsWith("<?php", index)) { index += 5; continue; }
    if (source.startsWith("<?=", index)) { index += 3; continue; }
    if (source.startsWith("<?", index)) { index += 2; continue; }
    if (source.startsWith("?>", index)) { index += 2; inPhp = false; continue; }
    if (source.startsWith("//", index) || (char === "#" && source[index + 1] !== "[")) {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (source.startsWith("<<<", index)) {
      const firstLineEnd = source.indexOf("\n", index);
      if (firstLineEnd >= 0) {
        const label = source.slice(index + 3, firstLineEnd).trim().replace(/^["']|["']$/g, "").split(/[;,\s]/)[0];
        const rest = source.slice(firstLineEnd + 1);
        let lineOffset = 0;
        let found = false;
        for (const line of rest.split(/(?<=\n)/)) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(label) && line.trim().replace(/[;,]$/, "") === label) {
            index = firstLineEnd + 1 + lineOffset + line.length;
            found = true;
            break;
          }
          lineOffset += line.length;
        }
        if (!found) index = source.length;
        continue;
      }
      index = source.length;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index++;
      let value = "";
      while (index < source.length) {
        const next = source[index] ?? "";
        if (next === "\\" && index + 1 < source.length) {
          value += source[index + 1] ?? "";
          index += 2;
        } else if (next === quote) {
          index++;
          break;
        } else {
          value += next;
          index++;
        }
      }
      tokens.push({ kind: "string", value, start, end: index });
      continue;
    }
    if (char === "$" && /[A-Za-z_]/.test(source[index + 1] ?? "")) {
      index += 2;
      while (/[A-Za-z0-9_]/.test(source[index] ?? "")) index++;
      tokens.push({ kind: "variable", value: source.slice(start + 1, index), start, end: index });
      continue;
    }
    if (/[A-Za-z_\\]/.test(char)) {
      index++;
      while (/[A-Za-z0-9_\\]/.test(source[index] ?? "")) index++;
      tokens.push({ kind: "identifier", value: source.slice(start, index), start, end: index });
      continue;
    }
    if (/\d/.test(char)) {
      index++;
      while (/[A-Za-z0-9_.]/.test(source[index] ?? "")) index++;
      tokens.push({ kind: "number", value: source.slice(start, index), start, end: index });
      continue;
    }
    const operator = operators.find((item) => source.startsWith(item, index));
    if (operator) index += operator.length;
    else index++;
    tokens.push({ kind: "symbol", value: operator ?? char, start, end: index });
  }
  return tokens;
}

export function matchingPairs(tokens: readonly PhpToken[]): Map<number, number> {
  const matches = new Map<number, number>();
  const stack: number[] = [];
  const opening = new Set(["(", "[", "{"]);
  const closing = new Map([[ ")", "("], ["]", "["], ["}", "{"]]);
  for (let index = 0; index < tokens.length; index++) {
    const value = tokens[index]?.value;
    if (value && opening.has(value)) stack.push(index);
    else if (value && closing.has(value)) {
      const open = stack.at(-1);
      if (open !== undefined && tokens[open]?.value === closing.get(value)) {
        stack.pop();
        matches.set(open, index);
        matches.set(index, open);
      }
    }
  }
  return matches;
}
