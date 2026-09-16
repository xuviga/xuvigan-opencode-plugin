/**
 * XuViGaN — единственный плагин который нужен
 *
 * Решает три боли:
 * 1. Нет памяти между сессиями → факты, предпочтения, паттерны
 * 2. Галлюцинации → проверка файлов и импортов
 * 3. Деструктивные операции → warn вместо block
 * 4. Повторяющиеся ошибки → база ошибок и решений
 *
 * Без лишнего: без GO-запросов, без over-guard, без спама.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"

// ===========================
// STORAGE
// ===========================

interface MemoryEntry {
  id: string
  type: "preference" | "decision" | "pattern" | "blocker"
  content: string
  source: "agent" | "user" | "auto"
  timestamp: number
  ttl?: number
  tags: string[]
}

interface ErrorEntry {
  id: string
  pattern: string
  description: string
  solution: string
  count: number
  resolved: boolean
  tags: string[]
  timestamp: number
}

interface Store {
  memory: MemoryEntry[]
  errors: ErrorEntry[]
}

type LogLevel = "debug" | "info" | "error" | "warn"

const STORE_LIMIT = 200

function getPath(dir: string, file: string): string {
  return join(dir, ".opencode", file)
}

function loadStore(dir: string, file: string, def: any): any {
  const p = getPath(dir, file)
  if (!existsSync(p)) return def
  try {
    return JSON.parse(readFileSync(p, "utf-8"))
  } catch {
    return def
  }
}

function saveStore(dir: string, file: string, data: any): void {
  const p = getPath(dir, file)
  const d = join(dir, ".opencode")
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  writeFileSync(p, JSON.stringify(data, null, 2))
}

// ===========================
// MEMORY
// ===========================

function memLoad(dir: string) {
  return loadStore(dir, "memory.json", { entries: [] })
}
function memSave(dir: string, data: any) {
  saveStore(dir, "memory.json", data)
}

function memAdd(dir: string, entry: Omit<MemoryEntry, "id" | "timestamp">) {
  const store = memLoad(dir)
  store.entries.push({ ...entry, id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now() })
  if (store.entries.length > STORE_LIMIT) store.entries = store.entries.slice(-STORE_LIMIT)
  memSave(dir, store)
}

function memSearch(dir: string, q: string): MemoryEntry[] {
  const store = memLoad(dir)
  const now = Date.now()
  const lower = q.toLowerCase()
  return (store.entries as MemoryEntry[])
    .filter((e: MemoryEntry) => !e.ttl || now - e.timestamp < e.ttl)
    .filter((e: MemoryEntry) => e.content.toLowerCase().includes(lower) || e.tags.some((t: string) => t.toLowerCase().includes(lower)))
}

function memFormat(entries: MemoryEntry[]): string {
  if (!entries.length) return ""
  const g: Record<string, MemoryEntry[]> = {}
  for (const e of entries) { (g[e.type] ??= []).push(e) }
  let out = "\n## Persistent Memory\n"
  for (const [type, list] of Object.entries(g)) {
    out += `\n### ${type.charAt(0).toUpperCase() + type.slice(1)}\n`
    for (const e of list) out += `- ${e.content}\n`
  }
  return out
}

// ===========================
// ERRORS
// ===========================

interface ErrorStore {
  errors: ErrorEntry[]
}

function errLoad(dir: string): ErrorStore {
  return loadStore(dir, "errors.json", { errors: [] })
}
function errSave(dir: string, data: ErrorStore) {
  saveStore(dir, "errors.json", data)
}

function findErrMatch(content: string, store: ErrorStore): ErrorEntry | undefined {
  return store.errors.find((e: ErrorEntry) => {
    try { return new RegExp(e.pattern, "i").test(content) } catch { return content.toLowerCase().includes(e.pattern.toLowerCase()) }
  })
}

// ===========================
// VERIFY
// ===========================

function extractImports(code: string): string[] {
  const out: string[] = []
  for (const p of [/from\s+['"]([^'"]+)['"]/g, /import\s+['"]([^'"]+)['"]/g, /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    let m; while ((m = p.exec(code)) !== null) out.push(m[1])
  }
  return out
}

function verifyPathExists(path: string, baseDir: string): boolean {
  if (path.startsWith("node:")) return true
  if (!path.startsWith(".") && !path.startsWith("/")) {
    // npm package
    const parts = path.split("/")
    const pkg = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]
    return existsSync(join(baseDir, "node_modules", pkg))
  }
  const resolved = join(baseDir, path)
  for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".json", ".mjs"]) {
    if (existsSync(resolved + ext)) return true
  }
  return false
}

interface VerifyResult {
  valid: boolean
  issues: string[]
  warnings: string[]
}

function verifyCode(code: string, filePath: string, baseDir: string): VerifyResult {
  const r: VerifyResult = { valid: true, issues: [], warnings: [] }
  const imports = extractImports(code)
  const codeDir = filePath ? dirname(join(baseDir, filePath)) : baseDir

  for (const imp of imports) {
    if (imp.startsWith(".")) {
      if (!verifyPathExists(imp, codeDir)) {
        r.issues.push(`Import not found: ${imp}`)
        r.valid = false
      }
    } else {
      if (!verifyPathExists(imp, baseDir)) {
        r.warnings.push(`Package may not be installed: ${imp}`)
      }
    }
  }
  return r
}

// ===========================
// GUARD (warn, not block)
// ===========================

const GUARD_WARN: Array<{ pattern: RegExp; reason: string; suggestion?: string }> = [
  { pattern: /rm\s+-rf\s+/i, reason: "Recursive force delete", suggestion: "Specify exact files" },
  { pattern: /git\s+push\s+--force/i, reason: "Force push overwrites remote", suggestion: "Use --force-with-lease" },
  { pattern: /git\s+reset\s+--hard/i, reason: "Hard reset discards changes", suggestion: "Stash first" },
  { pattern: /git\s+clean\s+-fd/i, reason: "Git clean deletes untracked files", suggestion: "Use clean -n to preview" },
  { pattern: /curl\s+[^|]*\|\s*(bash|sh)/i, reason: "Remote shell piping", suggestion: "Download and inspect first" },
]

const GUARD_PROTECT_SENSITIVE = [/\.env/, /\.aws\/credentials/, /\.ssh\/id_/, /\.git-credentials/, /\.npmrc/]

function checkSensitive(path: string): boolean {
  return GUARD_PROTECT_SENSITIVE.some((p) => p.test(path))
}

function checkGuard(content: string): string[] {
  const issues: string[] = []
  for (const { pattern, reason, suggestion } of GUARD_WARN) {
    if (pattern.test(content)) issues.push(`⚠️ ${reason}${suggestion ? ` — ${suggestion}` : ""}`)
  }
  return issues
}

// ===========================
// MAIN PLUGIN
// ===========================

export const XuViGaNPlugin: Plugin = async ({ directory, client }) => {

  function log(level: LogLevel, message: string, extra?: any) {
    client.app.log({ body: { service: "xuvigan", level, message, extra } }).catch(() => {})
  }

  return {
    // Auto-inject memory on session start (minimal — just one reminder of key facts)
    event: async ({ event }: any) => {
      if (event.type === "session.created") {
        const mem = memLoad(directory)
        // Only inject preferences and blockers — not every pattern
        const useful = (mem.entries as MemoryEntry[]).filter((e: MemoryEntry) => e.type === "preference" || e.type === "blocker")
        if (useful.length > 0) {
          const txt = "\n## Reminder\n" + useful.map((e: MemoryEntry) => `- ${e.content}`).join("\n") + "\n"
          await client.session.prompt({
            path: { id: event.properties.sessionID as string },
            body: { noReply: true, parts: [{ type: "text", text: txt }] },
          }).catch(() => {})
        }
      }
    },

    // After tool execution — check for errors, warn about issues
    "tool.execute.after": async (input: any, output: any) => {
      // Bash errors — check known patterns
      if (input.tool === "bash") {
        const out = (output.result || output.stdout || output.error || "") as string
        if (!out) return

        // Known error match?
        const store = errLoad(directory)
        const match = findErrMatch(out, store)
        if (match && !match.resolved) {
          match.count++
          errSave(directory, store)
          log("warn", `Known error #${match.count}: ${match.description}`, { solution: match.solution })
        }
      }

      // Write/edit — verify code, count sensitive files
      if ((input.tool === "write" || input.tool === "edit")) {
        const filePath = (input.args?.filePath || input.args?.path || "") as string
        if (!filePath) return

        // Warn if sensitive
        if (checkSensitive(filePath)) {
          log("warn", `Sensitive file written: ${filePath}`, {})
        }

        // Verify code files (non-blocking)
        if (/\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) {
          try {
            const full = join(directory, filePath)
            const content = readFileSync(full, "utf-8")
            const v = verifyCode(content, filePath, directory)
            if (!v.valid) {
              log("warn", `${filePath}: import issues`, { issues: v.issues })
            }
          } catch {}
        }
      }
    },

    // Before tool execution — only warn, don't block
    "tool.execute.before": async (input: any, output: any) => {
      // Guard check: dangerous commands — warn, let user decide
      if (input.tool === "bash") {
        const cmd = (input.args?.command || "") as string
        const issues = checkGuard(cmd)
        if (issues.length > 0) {
          // Prepend warning to output
          output.args = output.args || {}
          output.args.__guard_warning = issues.join(" | ")
        }
      }

      // Write check: sensitive files — warn
      if (input.tool === "write" || input.tool === "edit") {
        const filePath = (input.args?.filePath || input.args?.path || "") as string
        if (checkSensitive(filePath)) {
          output.args = output.args || {}
          output.args.__sensitive_warning = "Sensitive file — verify before committing"
        }
      }
    },

    // ---- TOOLS ----
    tool: {
      // Memory
      memory_remember: {
        description: "Save a fact to persistent memory. Types: preference, decision, pattern, blocker",
        args: {
          content: String,
          type: String,           // preference | decision | pattern | blocker
          tags: String,           // comma-separated
          ttl: Number,            // ms, 0 = permanent
        },
        execute: async (args: any, ctx: any) => {
          memAdd(ctx.directory, {
            type: args.type as MemoryEntry["type"],
            content: args.content,
            source: "agent",
            tags: (args.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean),
            ttl: args.ttl || undefined,
          })
          return `Remembered: ${args.content}`
        },
        output: String,
      } as any,

      memory_search: {
        description: "Search persistent memory",
        args: { query: String },
        execute: async (args: any, ctx: any) => {
          const results = memSearch(ctx.directory, args.query)
          if (!results.length) return "No matching memories"
          return results.map((e) => `[${e.type}] ${e.content} (tags: ${e.tags.join(",") || "-"})`).join("\n")
        },
        output: String,
      } as any,

      memory_forget: {
        description: "Remove memories matching query",
        args: { query: String },
        execute: async (args: any, ctx: any) => {
          const store = memLoad(ctx.directory)
          const before = store.entries.length
          store.entries = store.entries.filter((e: MemoryEntry) => !e.content.toLowerCase().includes(args.query.toLowerCase()))
          memSave(ctx.directory, store)
          return `Removed ${before - store.entries.length} entries`
        },
        output: String,
      } as any,

      // Errors
      error_check: {
        description: "Check if a command/output matches a known error pattern",
        args: { content: String },
        execute: async (args: any, ctx: any) => {
          const store = errLoad(ctx.directory)
          const match = findErrMatch(args.content, store)
          if (!match) return "No known error pattern"
          return `[${match.resolved ? "RESOLVED" : "UNRESOLVED"}] ${match.description}\nSolution: ${match.solution}\nSeen: ${match.count}x`
        },
        output: String,
      } as any,

      error_log: {
        description: "Log an error with its solution for future reference",
        args: { pattern: String, description: String, solution: String, tags: String },
        execute: async (args: any, ctx: any) => {
          const store = errLoad(ctx.directory)
          const tags = (args.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean)
          const existing = store.errors.find((e) => e.pattern.toLowerCase() === args.pattern.toLowerCase())
          if (existing) {
            existing.count++
            existing.resolved = false
            existing.timestamp = Date.now()
            errSave(ctx.directory, store)
            return `Updated: ${args.description} (x${existing.count})`
          }
          store.errors.push({
            id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            ...args, count: 1, resolved: false, tags, timestamp: Date.now(),
          })
          if (store.errors.length > STORE_LIMIT) store.errors = store.errors.slice(-STORE_LIMIT)
          errSave(ctx.directory, store)
          return `Logged: ${args.description}`
        },
        output: String,
      } as any,

      error_resolve: {
        description: "Mark an error pattern as resolved",
        args: { id: String },
        execute: async (args: any, ctx: any) => {
          const store = errLoad(ctx.directory)
          const e = store.errors.find((x) => x.id === args.id)
          if (!e) return `Error ${args.id} not found`
          e.resolved = true
          errSave(ctx.directory, store)
          return `Resolved: ${e.description}`
        },
        output: String,
      } as any,

      // Verify
      verify_check: {
        description: "Verify that recent edits (code files) don't reference non-existent imports",
        args: {},
        execute: async (_args: any, ctx: any) => {
          // Find recently modified .ts files
          try {
            const result = execSync("npx tsc --noEmit --skipLibCheck 2>&1", {
              cwd: ctx.directory, encoding: "utf-8", timeout: 20000,
            })
            return result.includes("error TS")
              ? `Errors found:\n${result.slice(0, 2000)}`
              : "TypeScript check passed."
          } catch (e: any) {
            return `Check failed: ${e.message}`
          }
        },
        output: String,
      } as any,

      verify_file: {
        description: "Verify that a file exists and is accessible",
        args: { path: String },
        execute: async (args: any, ctx: any) => {
          const fileName = args.path || args.filePath || ""
          if (!fileName) return "Error: no path provided"
          const full = join(ctx.directory, fileName)
          if (!existsSync(full)) return `NOT FOUND: ${fileName}`
          const c = readFileSync(full, "utf-8")
          return `File: ${fileName} (${c.length}b, ${c.split("\n").length} lines)`
        },
        output: String,
      } as any,

      verify_imports: {
        description: "Verify all imports in a file resolve correctly",
        args: { path: String },
        execute: async (args: any, ctx: any) => {
          const fileName = args.path || args.filePath || ""
          if (!fileName) return "Error: no path provided"
          const full = join(ctx.directory, fileName)
          if (!existsSync(full)) return `File not found: ${fileName}`
          const content = readFileSync(full, "utf-8")
          const v = verifyCode(content, fileName, ctx.directory)
          if (v.valid && v.warnings.length === 0) return `All imports OK in ${fileName}`
          let out = ""
          if (v.issues.length) out += `Issues:\n${v.issues.map((i) => `  ❌ ${i}`).join("\n")}\n`
          if (v.warnings.length) out += `Warnings:\n${v.warnings.map((w) => `  ⚠️ ${w}`).join("\n")}\n`
          return out
        },
        output: String,
      } as any,

      // Guard
      guard_scan: {
        description: "Scan a command or code for dangerous patterns",
        args: { content: String },
        execute: async (args: any, _ctx: any) => {
          const issues = checkGuard(args.content)
          if (!issues.length) return "No dangerous patterns detected"
          return "Found issues:\n" + issues.map((i) => `  - ${i}`).join("\n")
        },
        output: String,
      } as any,
    },
  }
}
