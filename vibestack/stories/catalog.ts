import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface Prop {
  name: string;
  kind: "boolean" | "number" | "string" | "union" | "function" | "node" | "object" | "array" | "unknown";
  required: boolean;
  options?: (string | number | boolean)[];
  default?: unknown;
  description?: string;
}
export interface Story { id: string; name: string; kind: "default" | "prop" | "state" | "example" | "model"; args: Record<string, unknown> }
export interface Component {
  id: string; name: string; package: string; title: string; description: string;
  source: { file: string; line: number }; props: Prop[]; stories: Story[];
  model?: { spec: string; module: string; state: string; events: string[] };
  design?: string[]; diagnostics: string[];
}
export interface ComponentIndex { version: 1; storybook: { url?: string }; components: Component[] }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const relative = (from: string, to: string) => {
  const name = path.relative(from, to).split(path.sep).join("/");
  return name.startsWith(".") ? name : `./${name}`;
};
function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() && file.endsWith(".tsx") && !/\.(meta|test|stories)\.tsx$/.test(file) ? [file] : [];
  });
}
function write(file: string, text: string) {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return node.kind === ts.SyntaxKind.TrueKeyword;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => literal(element));
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) return [];
    const value = literal(property.initializer);
    return value === undefined ? [] : [[property.name.getText().replace(/^["']|["']$/g, ""), value]];
  }));
  return undefined;
}
function metadataAt(file: string): { args?: Record<string, unknown>; examples?: Record<string, Record<string, unknown>>; model?: Component["model"]; design?: string[] } {
  if (!fs.existsSync(file)) return {};
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
    const meta = statement.declarationList.declarations.find((d) => d.name.getText(source) === "meta");
    if (meta?.initializer) return (literal(meta.initializer) ?? {}) as ReturnType<typeof metadataAt>;
  }
  return {};
}
function properties(type: ts.Type, checker: ts.TypeChecker, root: string): Prop[] {
  return type.getProperties().filter((p) => p.declarations?.some((d) => d.getSourceFile().fileName.startsWith(root) && !d.getSourceFile().fileName.includes("node_modules")) || ["children", "disabled", "className"].includes(p.name)).map((p) => {
    const at = p.valueDeclaration ?? p.declarations![0]!;
    const value = checker.getTypeOfSymbolAtLocation(p, at);
    const members = value.isUnion() ? value.types.filter((v) => !(v.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))) : [value];
    const options = members.flatMap((v): (string | number | boolean)[] => v.isStringLiteral() || v.isNumberLiteral() ? [v.value] : v.flags & ts.TypeFlags.BooleanLiteral ? [(v as ts.Type & { intrinsicName: string }).intrinsicName === "true"] : []);
    const kind: Prop["kind"] = p.name === "children" ? "node" : members.every((v) => v.flags & ts.TypeFlags.BooleanLike) ? "boolean" : options.length === members.length ? "union" : value.getCallSignatures().length ? "function" : checker.isArrayType(value) ? "array" : members.every((v) => v.flags & ts.TypeFlags.StringLike) ? "string" : members.every((v) => v.flags & ts.TypeFlags.NumberLike) ? "number" : "object";
    return { name: p.name, kind, required: !(p.flags & ts.SymbolFlags.Optional), ...(options.length === members.length && kind !== "node" ? { options } : {}), description: ts.displayPartsToString(p.getDocumentationComment(checker)) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Read component sources once and describe the catalog and disposable CSF artifacts. */
function inspect(root: string, out: string): { catalog: ComponentIndex; stories: Map<string, string> } {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name: string };
  const sources = files(path.join(root, "src"));
  const configPath = ts.findConfigFile(root, ts.sys.fileExists);
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : undefined;
  const options = configPath && config ? ts.parseJsonConfigFileContent(config.config, ts.sys, root).options : { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const program = ts.createProgram(sources, options), checker = program.getTypeChecker();
  const catalog: ComponentIndex = { version: 1, storybook: {}, components: [] };
  const generated = new Map<string, string>();
  for (const file of sources) {
    const source = program.getSourceFile(file)!;
    const module = checker.getSymbolAtLocation(source);
    for (const symbol of module ? checker.getExportsOfModule(module) : []) {
      if (!/^[A-Z]/.test(symbol.name) || !(symbol.flags & ts.SymbolFlags.Value)) continue;
      const declared = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declared) continue;
      const type = checker.getTypeOfSymbolAtLocation(symbol, declared);
      const signature = type.getCallSignatures()[0];
      if (!signature || !/Element|ReactNode|ReactElement/.test(checker.typeToString(signature.getReturnType()))) continue;
      const scope = path.relative(path.join(root, "src"), path.dirname(file)).split(path.sep).join("/");
      const title = `${pkg.name}/${scope ? `${scope}/` : ""}${symbol.name}`, id = slug(title);
      const parameter = signature.parameters[0];
      const props = parameter ? properties(checker.getTypeOfSymbolAtLocation(parameter, declared), checker, root) : [];
      const binding = signature.getDeclaration()?.parameters[0]?.name;
      if (binding && ts.isObjectBindingPattern(binding)) for (const element of binding.elements) {
        const prop = props.find((p) => p.name === (element.propertyName ?? element.name).getText());
        if (prop && element.initializer) prop.default = literal(element.initializer);
      }
      const line = source.getLineAndCharacterOfPosition(declared.getStart()).line + 1;
      const defaults = Object.fromEntries(props.filter((prop) => prop.default !== undefined).map((prop) => [prop.name, prop.default]));
      const stories: Story[] = [{ id: `${id}--default`, name: "Default", kind: "default", args: {} }];
      for (const prop of props) for (const value of prop.options ?? (prop.kind === "boolean" ? [false, true] : [])) {
        const name = `${prop.name}-${String(value)}`;
        stories.push({ id: `${id}--variant${stories.length}`, name, kind: "prop", args: { [prop.name]: value } });
      }
      const metaFile = file.replace(/\.tsx$/, ".meta.tsx");
      const metadata = symbol.name === path.basename(file, ".tsx") && fs.existsSync(metaFile);
      const meta = metadata ? metadataAt(metaFile) : {};
      for (const story of stories) story.args = { ...defaults, ...meta.args, ...story.args };
      const examples = Object.entries(meta.examples ?? {});
      for (const [index, [name, args]] of examples.entries()) stories.push({ id: `${id}--example${index + 1}`, name, kind: "example", args: { ...defaults, ...meta.args, ...args } });
      const name = `${id}.stories.tsx`;
      const imports = `import { ${symbol.name} } from ${JSON.stringify(relative(out, file))};\n` + (metadata ? `import { meta } from ${JSON.stringify(relative(out, metaFile))};\n` : "const meta = { args: {} };\n");
      let example = 0;
      const exports = stories.map((story, index) => {
        const named = story.kind === "example";
        const exported = named ? `Example${++example}` : index ? `Variant${index}` : "Default";
        const args = named ? `meta.examples?.[${JSON.stringify(story.name)}]` : JSON.stringify(story.args);
        return `export const ${exported} = { name: ${JSON.stringify(story.name)}, args: { ...meta.args, ...${args} } };`;
      }).join("\n");
      generated.set(name, `${imports}export default { title: ${JSON.stringify(title)}, component: ${symbol.name}, args: meta.args };\n${exports}\n`);
      catalog.components.push({ id, name: symbol.name, package: pkg.name, title, description: ts.displayPartsToString(symbol.getDocumentationComment(checker)), source: { file: relative(root, file), line }, props, stories, ...(meta.model ? { model: meta.model } : {}), ...(meta.design ? { design: meta.design } : {}), diagnostics: props.filter((p) => p.required && !(p.name in (meta.args ?? {}))).map((p) => `${p.name}: provide a renderable example in ${path.basename(metaFile)}`) });
    }
  }
  catalog.components.sort((a, b) => a.id.localeCompare(b.id));
  return { catalog, stories: generated };
}

/** Read-only component discovery for Studio's catalog endpoint. */
export function scanCatalog(directory: string): ComponentIndex {
  const root = path.resolve(directory);
  return inspect(root, path.join(root, ".storybook/generated")).catalog;
}

/** Write stable CSF modules and the same catalog Studio reads; leave unchanged files untouched. */
export function generateCatalog(directory: string, output = ".storybook/generated"): ComponentIndex {
  const root = path.resolve(directory), out = path.resolve(root, output);
  const { catalog, stories } = inspect(root, out);
  for (const [name, text] of stories) write(path.join(out, name), text);
  write(path.join(out, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  for (const file of fs.readdirSync(out)) if (file.endsWith(".stories.tsx") && !stories.has(file)) fs.rmSync(path.join(out, file));
  return catalog;
}
