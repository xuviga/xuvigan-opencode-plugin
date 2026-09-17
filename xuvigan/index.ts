/**
 * XuViGaN plugin — automatic hooks
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

// ===========================
// TYPES & STORAGE
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

interface MemoryStore { entries: MemoryEntry[] }
interface ErrorStore { errors: ErrorEntry[] }

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

function memAdd(dir: string, entry: Omit<MemoryEntry, "id" | "timestamp">): void {
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
// PLUGIN
// ===========================

export const id = "xuvigan"

import { homedir } from "node:os"

function getGlobalMemoryDir() {
  return join(homedir(), ".config", "opencode", ".opencode")
}

export async function server({ client }: {
  client: {
    app: {
      log: (opts: { body: { service: string; level: string; message: string; extra?: unknown } }) => Promise<void>
    }
    session: {
      prompt: (opts: {
        path: { id: string }
        body: { noReply?: boolean; parts: Array<{ type: string; text: string }> }
      }) => Promise<unknown>
    }
  }
}) {
  function log(level: "debug" | "info" | "error" | "warn", message: string) {
    try {
      client.app.log({ body: { service: "xuvigan", level, message } }).catch(() => {})
    } catch {}
  }

  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type === "session.created") {
        const memDir = getGlobalMemoryDir()
        const mem = loadStore(memDir, "memory.json", { entries: [] })
        const useful = mem.entries.filter((e: MemoryEntry) => e.type === "preference" || e.type === "blocker")
        if (useful.length > 0) {
          const txt = "\n## Reminder\n" + useful.map((e: MemoryEntry) => `- ${e.content}`).join("\n") + "\n"
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

    "tool.execute.after": async (input: { tool: string; args?: Record<string, unknown> }, output: { result?: unknown; stdout?: string; error?: unknown }) => {
      if (input.tool === "bash") {
        const out = (output.result || output.stdout || output.error || "") as string
        if (!out) return

        const store = errLoad(getGlobalMemoryDir())
        const match = findErrMatch(out, store)
        if (match && !match.resolved) {
          match.count++
          errSave(getGlobalMemoryDir(), store)
          log("warn", `Known error #${match.count}: ${match.description}. Solution: ${match.solution}`)
        }
      }

      if ((input.tool === "write" || input.tool === "edit")) {
        const filePath = (input.args?.filePath || input.args?.path || "") as string
        if (!filePath) return

        if ([/\.env/, /\.aws\/credentials/, /\.ssh\/id_/, /\.git-credentials/, /\.npmrc/].some((p) => p.test(filePath))) {
          log("warn", `Sensitive file written: ${filePath}`)
        }

        if (/\.(ts|tsx|js|jsx|mjs)$/.test(filePath)) {
          try {
            const full = join(process.cwd(), filePath)
            const content = readFileSync(full, "utf-8")
            const imports: string[] = []
            for (const p of [
              /from\s+['"]([^'"]+)['"]/g,
              /import\s+['"]([^'"]+)['"]/g,
              /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            ]) {
              let m
              while ((m = p.exec(content)) !== null) imports.push(m[1])
            }
            const codeDir = join(process.cwd(), filePath.split("/").slice(0, -1).join("/"))
            const issues: string[] = []
            for (const imp of imports) {
              if (imp.startsWith(".")) {
                const resolved = join(codeDir, imp)
                let found = false
                for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".json", ".mjs"]) {
                  if (existsSync(resolved + ext)) {
                    found = true
                    break
                  }
                }
                if (!found) issues.push(`Import not found: ${imp}`)
              }
            }
            if (issues.length > 0) {
              log("warn", `${filePath}: ${issues.join("; ")}`)
            }
          } catch {}
        }
      }
    },

    "tool.execute.before": async (input: { tool: string; args?: Record<string, unknown> }, output: { args?: Record<string, unknown> }) => {
      if (input.tool === "bash") {
        const cmd = (input.args?.command || "") as string
        const issues: string[] = []
        for (const { pattern, reason, suggestion } of [
          { pattern: /rm\s+-rf\s+/i, reason: "Recursive force delete", suggestion: "Specify exact files" },
          { pattern: /git\s+push\s+--force/i, reason: "Force push overwrites remote", suggestion: "Use --force-with-lease" },
          { pattern: /git\s+reset\s+--hard/i, reason: "Hard reset discards changes", suggestion: "Stash first" },
          { pattern: /git\s+clean\s+-fd/i, reason: "Git clean deletes untracked files", suggestion: "Use clean -n to preview" },
          { pattern: /curl\s+[^|]*\|\s*(bash|sh)/i, reason: "Remote shell piping", suggestion: "Download and inspect first" },
        ]) {
          if (pattern.test(cmd)) issues.push(`⚠️ ${reason}${suggestion ? ` — ${suggestion}` : ""}`)
        }
        if (issues.length > 0) {
          output.args = output.args || {}
          output.args.__guard_warning = issues.join(" | ")
        }
      }

      if (input.tool === "write" || input.tool === "edit") {
        const filePath = (input.args?.filePath || input.args?.path || "") as string
        if ([/\.env/, /\.aws\/credentials/, /\.ssh\/id_/, /\.git-credentials/, /\.npmrc/].some((p) => p.test(filePath))) {
          output.args = output.args || {}
          output.args.__sensitive_warning = "Sensitive file — verify before committing"
        }
      }
    },
  }
}
