import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

export function removeTsxPreloads(file, source) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0].message}`);
  const ranges = [];
  const nodes = [];
  const bindings = [];
  const candidates = new Map();
  const exported = new Set();
  const loaderPattern = /(?:["']tsx(?:\/|["'])|["'/]node_modules\/(?:tsx\/|\.bin\/tsx["']))/;
  const pending = [parsed.program];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    nodes.push(node);
    if (node.type === "VariableDeclarator") bindings.push(source.slice(node.id.start, node.id.end));
    if (node.params) for (const param of node.params) bindings.push(source.slice(param.start, param.end));
    if (node.type === "FunctionDeclaration" && node.id) bindings.push(node.id.name);
    if (node.type === "CatchClause" && node.param) bindings.push(source.slice(node.param.start, node.param.end));
    if (node.type === "ExportNamedDeclaration" && node.declaration?.type === "VariableDeclaration") {
      for (const declaration of node.declaration.declarations) exported.add(declaration);
    }
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const declaration of node.declarations) {
        if (declaration.id.type === "Identifier" && declaration.init) {
          candidates.set(declaration.id.name, {
            text: source.slice(declaration.init.start, declaration.init.end), declaration, parent: node,
          });
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  for (const [name] of candidates) {
    if (bindings.filter(binding => binding.includes(name)).length !== 1) candidates.delete(name);
  }
  const textOf = node => node?.type === "Identifier"
    ? candidates.get(node.name)?.text ?? source.slice(node.start, node.end)
    : node ? source.slice(node.start, node.end) : "";
  for (const node of nodes) {
    if (node.type === "ArrayExpression") {
      const elements = node.elements;
      const removed = new Set();
      if (elements[0]?.type !== "ArrayExpression"
        && !(typeof elements[0]?.value === "string" && /^node\s/.test(elements[0].value))
        && /\/tsx\/dist\/cli\.mjs|\/node_modules\/\.bin\/tsx["']/.test(textOf(elements[0]))) removed.add(0);
      for (let i = 0; i < elements.length - 1; i++) {
        if (elements[i]?.value === "--import" && elements[i + 1]
          && loaderPattern.test(textOf(elements[i + 1]))) {
          removed.add(i); removed.add(++i);
        }
      }
      for (let i = 0; i < elements.length; i++) {
        if (!removed.has(i)) continue;
        const first = i;
        while (removed.has(i + 1)) i++;
        if (i + 1 < elements.length && elements[i + 1]) {
          ranges.push([elements[first].start, elements[i + 1].start]);
        } else if (first > 0 && elements[first - 1]) {
          ranges.push([elements[first - 1].end, elements[i].end]);
        } else {
          ranges.push([elements[first].start, elements[i].end]);
        }
      }
    }
  }
  const dead = new Map();
  for (const [name, candidate] of candidates) {
    const { declaration, parent, text } = candidate;
    if (exported.has(declaration) || declaration.init?.type === "ArrayExpression"
      || !loaderPattern.test(text)) continue;
    const live = nodes.some(node => node.type === "Identifier" && node.name === name
      && !(node.start >= declaration.start && node.end <= declaration.end)
      && !ranges.some(([start, end]) => node.start >= start && node.end <= end));
    if (!live) {
      if (!dead.has(parent)) dead.set(parent, new Set());
      dead.get(parent).add(parent.declarations.indexOf(declaration));
    }
  }
  for (const [parent, removed] of dead) {
    const elements = parent.declarations;
    if (removed.size === elements.length) {
      let start = parent.start, end = parent.end;
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      const newline = source.indexOf("\n", end);
      const lineEnd = newline < 0 ? source.length : newline;
      if (!source.slice(lineStart, start).trim() && !source.slice(end, lineEnd).trim()) {
        start = lineStart; end = newline < 0 ? lineEnd : newline + 1;
      }
      ranges.push([start, end]); continue;
    }
    for (let i = 0; i < elements.length; i++) {
      if (!removed.has(i)) continue;
      const first = i;
      while (removed.has(i + 1)) i++;
      if (i + 1 < elements.length) ranges.push([elements[first].start, elements[i + 1].start]);
      else ranges.push([elements[first - 1].end, elements[i].end]);
    }
  }
  const outer = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
    if (!outer.length || range[0] >= outer.at(-1)[1]) outer.push(range);
    else outer.at(-1)[1] = Math.max(outer.at(-1)[1], range[1]);
  }
  for (const [start, end] of outer.reverse()) source = source.slice(0, start) + source.slice(end);
  return source;
}

if (import.meta.main) {
  const files = process.argv.length > 2 ? process.argv.slice(2)
    : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0");
  let changed = 0;
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || /^(?:node_modules|vendor)\//.test(file) || !existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes("tsx")) continue;
    const updated = removeTsxPreloads(file, source);
    if (updated !== source) { writeFileSync(file, updated); changed++; }
  }
  console.log(`Removed obsolete tsx preloads from ${changed} files.`);
}
