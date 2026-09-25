/**
 * Generates the API reference (`api/*.md`) from effect-assistant's JSDoc.
 *
 * One page per public module: the module description, then every export
 * grouped by `@category`, with its description and signature. It reads the
 * source as text (no TypeScript compiler API), so it relies on the repo's
 * JSDoc conventions: a block right before each `export`, and `@category` /
 * `@since` tags.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

const src = path.resolve(import.meta.dirname, "../../../packages/effect-assistant/src")

const out = path.resolve(import.meta.dirname, "../api")

interface Doc {
  readonly description: string
  readonly tags: ReadonlyMap<string, string>
}

/** The text of a `/** … *\/` block, without the stars, split into prose and tags. */
const parseDoc = (block: string): Doc => {
  const lines = block
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))

  const tags = new Map<string, string>()
  const prose: Array<string> = []

  for (const line of lines) {
    const tag = /^@(\w+)\s*(.*)$/.exec(line.trim())

    if (tag !== null) tags.set(tag[1]!, tag[2]!)
    else prose.push(line)
  }

  return { description: prose.join("\n").trim(), tags }
}

/** Turns `{@link X}` into inline code. */
const links = (text: string) => text.replaceAll(/\{@link ([^}]+)\}/g, "`$1`")

interface Declaration {
  readonly name: string
  readonly kind: string
  readonly signature: string
  readonly doc: Doc
}

const declarations = (source: string): ReadonlyArray<Declaration> => {
  const found: Array<Declaration> = []
  const pattern = /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*(?:\/\/[^\n]*\n\s*)*export (const|class|interface|type) (\w+)/g

  for (const match of source.matchAll(pattern)) {
    const [, block, kind, name] = match
    const start = match.index + match[0].length - `export ${kind} ${name}`.length
    found.push({ name: name!, kind: kind!, signature: signatureAt(source, start), doc: parseDoc(block!) })
  }

  return found
}

/**
 * Scans from `start` and returns the index just past the first top-level
 * match of `stop`, skipping strings and bracketed groups.
 */
const scanTo = (text: string, start: number, stop: (text: string, at: number) => number): number => {
  let depth = 0
  let quote: string | undefined

  for (let at = start; at < text.length; at++) {
    const char = text[at]!

    if (quote !== undefined) {
      if (char === "\\") at++
      else if (char === quote) quote = undefined
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }

    if (depth === 0) {
      const matched = stop(text, at)

      if (matched > 0) return at + matched
    }

    if ("([{".includes(char) || (char === "<" && /[\w)\]]/.test(text[at - 1] ?? "") === false)) depth++

    if (char === "<" && /[A-Za-z]/.test(text[at - 1] ?? "")) depth++

    if (")]}".includes(char)) depth--

    if (char === ">" && text[at - 1] !== "=" && depth > 0) depth--
  }

  return text.length
}

const arrow = (text: string, at: number) => (text.startsWith("=>", at) ? 2 : 0)

const assignment = (text: string, at: number) =>
  text[at] === "=" && text[at + 1] !== ">" && text[at + 1] !== "=" && text[at - 1] !== "=" && text[at - 1] !== "!"
    ? 1
    : 0

/** The declaration's signature: a type, or a function's parameters and return type. Never a body. */
const signatureAt = (source: string, start: number): string => {
  const head = /^export (const|class|interface|type) (\w+)/.exec(source.slice(start))!
  const [whole, kind, name] = head
  const after = start + whole.length

  if (kind === "interface" || kind === "type" || kind === "class") {
    // Up to the end of the declaration: `{}` for classes, the closing brace or end of statement otherwise.
    const end =
      kind === "class"
        ? source.indexOf("{}", after) + 2
        : scanTo(source, after, (text, at) =>
            text[at] === "\n" && text[at + 1] !== " " && text[at + 1] !== "}" ? 1 : 0
          )

    return source
      .slice(start + "export ".length, end)
      .trim()
      .replace(/\s*\{\}$/, "")
  }

  const rest = source.slice(after)

  if (rest.startsWith(":")) {
    const end = scanTo(source, after, assignment)

    return `const ${name}${source.slice(after, end - 1).trimEnd()}`
  }

  // `const name = <G>(params): Return => body`, or some other expression.
  const valueStart = source.indexOf("=", after) + 1
  const value = source.slice(valueStart).trimStart()

  if (value.startsWith("<") || value.startsWith("(")) {
    const offset = source.length - value.length
    const end = scanTo(source, offset, arrow)
    const fn = source.slice(offset, end - 2).trim()
    const typed = /^([\s\S]*\))\s*:\s*([\s\S]+)$/.exec(fn)

    return typed === null ? `const ${name}: ${fn} => …` : `const ${name}: ${typed[1]} => ${typed[2]}`
  }

  const firstLine = value.split("\n")[0]!

  return `const ${name} = ${firstLine}${firstLine.trimEnd().endsWith(")") ? "" : " …"}`
}

const order = [
  "constructors",
  "layers",
  "services",
  "combinators",
  "models",
  "schemas",
  "inputs",
  "turns",
  "guards",
  "getters",
  "folding",
  "errors",
  "utility types"
]

const page = (module: string, source: string): string => {
  const moduleDoc = /^\/\*\*[\s\S]*?\*\//.exec(source)
  const intro = moduleDoc === null ? "" : links(parseDoc(moduleDoc[0]).description)
  const byCategory = new Map<string, Array<Declaration>>()

  for (const declaration of declarations(source)) {
    const category = declaration.doc.tags.get("category") ?? "other"
    byCategory.set(category, [...(byCategory.get(category) ?? []), declaration])
  }

  const categories = [...byCategory.keys()].sort((a, b) => {
    const rank = (c: string) => (order.indexOf(c) === -1 ? order.length : order.indexOf(c))

    return rank(a) - rank(b) || a.localeCompare(b)
  })

  const sections = categories.map((category) => {
    const items = byCategory
      .get(category)!
      .map((declaration) =>
        [
          `### ${declaration.name}`,
          "",
          links(declaration.doc.description),
          "",
          "```ts",
          declaration.signature,
          "```",
          "",
          `<small>Since ${declaration.doc.tags.get("since") ?? "0.1.0"}</small>`
        ].join("\n")
      )

    return [`## ${category[0]!.toUpperCase()}${category.slice(1)}`, ...items].join("\n\n")
  })

  return [
    "<!-- Generated by apps/docs/scripts/api.ts from the JSDoc in packages/effect-assistant/src. Do not edit. -->",
    "",
    `# ${module}`,
    "",
    "```ts",
    `import { ${module} } from "effect-assistant"`,
    "```",
    "",
    intro,
    "",
    sections.join("\n\n")
  ].join("\n")
}

const modules = readdirSync(src)
  .filter((file) => file.endsWith(".ts") && file !== "index.ts")
  .map((file) => file.replace(/\.ts$/, ""))
  .sort()

for (const module of modules) {
  writeFileSync(
    path.join(out, `${module}.md`),
    `${page(module, readFileSync(path.join(src, `${module}.ts`), "utf8"))}\n`
  )
}

writeFileSync(
  path.join(out, "index.md"),
  [
    "<!-- Generated by apps/docs/scripts/api.ts. Do not edit. -->",
    "",
    "# API reference",
    "",
    "Every public module of effect-assistant, generated from its JSDoc. Import them from the package root:",
    "",
    "```ts",
    `import { Assistant, AssistantEvent, ChatLog } from "effect-assistant"`,
    "```",
    "",
    "or one module at a time, as Effect does:",
    "",
    "```ts",
    `import * as Assistant from "effect-assistant/Assistant"`,
    "```",
    "",
    ...modules.map((module) => `- [${module}](./${module})`)
  ].join("\n") + "\n"
)

console.log(`api: ${modules.length} modules`)
