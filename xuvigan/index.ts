/**
 * XuViGaN — единственный плагин который нужен
 *
 * Memory + Errors + Verify + Guard
 * Автоматически: инъекция памяти, проверка ошибок, warn при опасных командах
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { execSync } from "node:child_process"

// ===========================
// STORAGE
// ===========================

interface MemoryEntry {
  id: string
  type: string
  content: string
  source: string
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

interface MemoryStore {
  entries: MemoryEntry[]
}

interface ErrorStore {
  errors: ErrorEntry[]
}

const STORE_LIMIT = 200

function getPath(dir: string, file: string): string {
  return join(dir, ".opencode", file)
}

function loadStore<T>(dir: string, file: string, def: T): T {
  const p = getPath(dir, file)
  if (!existsSync(p)) return def
  try {
    return JSON.parse(readFileSync(p, "utf-8"))
  } catch {
    return def
  }
}

function saveStore(dir: string, file: string, data: unknown): void {
  const p = getPath(dir, file)
  const d = join(dir, ".opencode")
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  writeFileSync(p, JSON.stringify(data, null, 2))
}

// ===========================
// MEMORY
// ===========================

function memLoad(dir: string): MemoryStore {
  return loadStore(dir, "memory.json", { entries: [] })
}

function memSave(dir: string, data: MemoryStore): void {
  saveStore(dir, "memory.json", data)
}

function memAdd(dir: string, entry: Omit<MemoryEntry, "id" | "timestamp">) {
  const store = memLoad(dir)
  store.entries.push({
    ...entry,
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
  })
  if (store.entries.length > STORE_LIMIT) {
    store.entries = store.entries.slice(-STORE_LIMIT)
  }
  memSave(dir, store)
}

function memSearch(dir: string, q: string): MemoryEntry[] {
  const store = memLoad(dir)
  const now = Date.now()
  const lower = q.toLowerCase()
  return store.entries
    .filter((e) => !e.ttl || now - e.timestamp < e.ttl)
    .filter((e) => e.content.toLowerCase().includes(lower) || e.tags.some((t) => t.toLowerCase().includes(lower)))
}

function memFormat(entries: MemoryEntry[]): string {
  if (!entries.length) return ""
  const g: Record<string, MemoryEntry[]> = {}
  for (const e of entries) {
    ;(g[e.type] ??= []).push(e)
  }
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

function errLoad(dir: string): ErrorStore {
  return loadStore(dir, "errors.json", { errors: [] })
}

function errSave(dir: string, data: ErrorStore): void {
  saveStore(dir, "errors.json", data)
}

function findErrMatch(content: string, store: ErrorStore): ErrorEntry | undefined {
  return store.errors.find((e) => {
    try {
      return new RegExp(e.pattern, "i").test(content)
    } catch {
      return content.toLowerCase().includes(e.pattern.toLowerCase())
    }
  })
}

// ===========================
// VERIFY
// ===========================

function extractImports(code: string): string[] {
  const out: string[] = []
  for (const p of [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    let m
    while ((m = p.exec(code)) !== null) out.push(m[1])
  }
  return out
}

function verifyPathExists(path: string, baseDir: string): boolean {
  if (path.startsWith("node:")) return true
  if (!path.startsWith(".") && !path.startsWith("/")) {
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
// GUARD
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
// PLUGIN
// ===========================

export const XuViGaNPlugin: Plugin = async ({ project, client, directory }) => {
  function log(level: "debug" | "info" | "error" | "warn", message: string) {
    try {
      client.app.log({ body: { service: "xuvigan", level, message } }).catch(() => {})
    } catch {}
  }

  return {
    // Auto-inject memory on session start
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type === "session.created") {
        const mem = memLoad(directory)
        const useful = mem.entries.filter((e) => e.type === "preference" || e.type === "blocker")
        if (useful.length > 0) {
          const txt = "\n## Reminder\n" + useful.map((e) => `- ${e.content}`).join("\n") + "\n"
          try {
            const sessionID = event.properties?.sessionID as string
            if (sessionID) {
              await client.session.prompt({
                path: { id: sessionID },
                body: { noReply: true, parts: [{ type: "text", text: txt }] },
              })
            }
          } catch {}
        }
      }
    },

    // After tool execution
    "tool.execute.after": async (input: any, output: any) => {
      if (input.tool === "bash") {
        const out = (output.result || output.stdout || output.error || "") as string
        if (!out) return

        const store = errLoad(directory)
        const match = findErrMatch(out, store)
        if (match && !match.resolved) {
          match.count++
          errSave(directory, store)
          log("warn", `Known error #${match.count}: ${match.description}. Solution: ${match.solution}`)
        }
      }

      if ((input.tool === "write" || input.tool === "edit")) {
        const filePath = (input.args?.filePath || input.args?.path || "") as string
        if (!filePath) return

        if (checkSensitive(filePath)) {
          log("warn", `Sensitive file written: ${filePath}`)
        }

        if (/\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) {
          try {
            const full = join(directory, filePath)
            const content = readFileSync(full, "utf-8")
            const v = verifyCode(content, filePath, directory)
            if (!v.valid) {
              log("warn", `${filePath}: ${v.issues.join("; ")}`)
            }
          } catch {}
        }
      }
    },

    // Before tool execution
    "tool.execute.before": async (input: any, output: any) => {
      if (input.tool === "bash") {
        const cmd = (input.args?.command || "") as string
        const issues = checkGuard(cmd)
        if (issues.length > 0) {
          output.args = output.args || {}
          output.args.__guard_warning = issues.join(" | ")
        }
      }

      if (input.tool === "write" || input.tool === "edit") {
        const filePath = (input.args?.filePath || input.args?.path || "") as string
        if (checkSensitive(filePath)) {
          output.args = output.args || {}
          output.args.__sensitive_warning = "Sensitive file — verify before committing"
        }
      }
    },

    // Custom tools
    tool: {
      memory_remember: tool({
        description: "Save a fact to persistent memory",
        args: {
          content: tool.schema.string().describe("The fact to remember"),
          type: tool.schema.string().describe("Type: preference, decision, pattern, blocker"),
          tags: tool.schema.string().describe("Comma-separated tags"),
          ttl: tool.schema.number().describe("Time to live in ms, 0 = permanent"),
        },
        execute: async (args, { worktree }) => {
          memAdd(worktree, {
            type: args.type,
            content: args.content,
            source: "agent",
            tags: (args.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
            ttl: args.ttl || undefined,
          })
          return `Remembered: ${args.content}`
        },
      }),

      memory_search: tool({
        description: "Search persistent memory",
        args: { query: tool.schema.string().describe("Search query") },
        execute: async (args, { worktree }) => {
          const results = memSearch(worktree, args.query)
          if (!results.length) return "No matching memories"
          return results
            .map((e) => `[${e.type}] ${e.content} (tags: ${e.tags.join(",") || "-"})`)
            .join("\n")
        },
      }),

      memory_forget: tool({
        description: "Remove memories matching query",
        args: { query: tool.schema.string().describe("Query to remove") },
        execute: async (args, { worktree }) => {
          const store = memLoad(worktree)
          const before = store.entries.length
          store.entries = store.entries.filter(
            (e) => !e.content.toLowerCase().includes(args.query.toLowerCase())
          )
          memSave(worktree, store)
          return `Removed ${before - store.entries.length} entries`
        },
      }),

      error_check: tool({
        description: "Check if a command/output matches a known error pattern",
        args: { content: tool.schema.string().describe("Error text to check") },
        execute: async (args, { worktree }) => {
          const store = errLoad(worktree)
          const match = findErrMatch(args.content, store)
          if (!match) return "No known error pattern"
          return `[${match.resolved ? "RESOLVED" : "UNRESOLVED"}] ${match.description}\nSolution: ${match.solution}\nSeen: ${match.count}x`
        },
      }),

      error_log: tool({
        description: "Log an error with its solution",
        args: {
          pattern: tool.schema.string().describe("Regex pattern to match"),
          description: tool.schema.string().describe("Description of error"),
          solution: tool.schema.string().describe("How to fix it"),
          tags: tool.schema.string().describe("Comma-separated tags"),
        },
        execute: async (args, { worktree }) => {
          const store = errLoad(worktree)
          const tags = (args.tags || "").split(",").map((t) => t.trim()).filter(Boolean)
          const existing = store.errors.find((e) => e.pattern.toLowerCase() === args.pattern.toLowerCase())
          if (existing) {
            existing.count++
            existing.resolved = false
            existing.timestamp = Date.now()
            errSave(worktree, store)
            return `Updated: ${args.description} (x${existing.count})`
          }
          store.errors.push({
            id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            ...args,
            count: 1,
            resolved: false,
            tags,
            timestamp: Date.now(),
          } as ErrorEntry)
          if (store.errors.length > STORE_LIMIT) store.errors = store.errors.slice(-STORE_LIMIT)
          errSave(worktree, store)
          return `Logged: ${args.description}`
        },
      }),

      error_resolve: tool({
        description: "Mark an error as resolved",
        args: { id: tool.schema.string().describe("Error ID") },
        execute: async (args, { worktree }) => {
          const store = errLoad(worktree)
          const e = store.errors.find((x) => x.id === args.id)
          if (!e) return `Error ${args.id} not found`
          e.resolved = true
          errSave(worktree, store)
          return `Resolved: ${e.description}`
        },
      }),

      verify_check: tool({
        description: "Run TypeScript check on project",
        args: { path: tool.schema.string().describe("Optional path") },
        execute: async (args, { worktree }) => {
          const target = args.path || worktree
          try {
            const result = execSync("npx tsc --noEmit --skipLibCheck 2>&1", {
              cwd: target,
              encoding: "utf-8",
              timeout: 20000,
            })
            return result.includes("error TS")
              ? `Errors:\n${result.slice(0, 2000)}`
              : "TypeScript check passed"
          } catch (e: any) {
            return `Check failed: ${e.message}`
          }
        },
      }),

      verify_file: tool({
        description: "Verify that a file exists",
        args: { path: tool.schema.string().describe("File path") },
        execute: async (args, { worktree }) => {
          const fileName = args.path || ""
          if (!fileName) return "Error: no path provided"
          const full = join(worktree, fileName)
          if (!existsSync(full)) return `NOT FOUND: ${fileName}`
          const c = readFileSync(full, "utf-8")
          return `File: ${fileName} (${c.length}b, ${c.split("\n").length} lines)`
        },
      }),

      verify_imports: tool({
        description: "Verify all imports in a file",
        args: { path: tool.schema.string().describe("File path") },
        execute: async (args, { worktree }) => {
          const fileName = args.path || ""
          if (!fileName) return "Error: no path provided"
          const full = join(worktree, fileName)
          if (!existsSync(full)) return `File not found: ${fileName}`
          const content = readFileSync(full, "utf-8")
          const v = verifyCode(content, fileName, worktree)
          if (v.valid && v.warnings.length === 0) return `All imports OK in ${fileName}`
          let out = ""
          if (v.issues.length) out += `Issues:\n${v.issues.map((i) => `  ❌ ${i}`).join("\n")}\n`
          if (v.warnings.length) out += `Warnings:\n${v.warnings.map((w) => `  ⚠️ ${w}`).join("\n")}\n`
          return out
        },
      }),

      guard_scan: tool({
        description: "Scan a command for dangerous patterns",
        args: { content: tool.schema.string().describe("Command to scan") },
        execute: async (args) => {
          const issues = checkGuard(args.content)
          if (!issues.length) return "No dangerous patterns detected"
          return "Found issues:\n" + issues.map((i) => `  - ${i}`).join("\n")
        },
      }),
    },
  }
}

export default XuViGaNPlugin
