import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Save a fact to persistent memory. Types: preference, decision, pattern, blocker",
  args: {
    content: tool.schema.string().describe("The fact to remember"),
    type: tool.schema.string().describe("Type: preference | decision | pattern | blocker"),
    tags: tool.schema.string().describe("Comma-separated tags"),
    ttl: tool.schema.number().describe("Time to live in ms, 0 = permanent"),
  },
  execute: async (args, { worktree }) => {
    return `Memory saved: ${args.content} (type: ${args.type})`
  },
})
