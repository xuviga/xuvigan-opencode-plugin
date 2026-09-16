# xuvigan-plugin

Plugin for OpenCode with memory, errors, verify, and guard functionality.

## Installation

```bash
cd ~/.config/opencode/plugins
git clone https://github.com/xuviga/xuvigan-opencode-plugin xuvigan
```

Add to `opencode.json`:

```json
{
  "plugin": ["file://./plugins/xuvigan"]
}
```

## What it does

- **Memory** — remembers facts across sessions
- **Errors** — logs known errors and their solutions
- **Verify** — checks imports and file existence
- **Guard** — warns about dangerous commands

## Tools (in ~/.config/opencode/tools/)

- `memory.ts` — save facts
- `memory_search.ts` — search memory

## Structure

```
plugins/
  xuvigan/
    index.ts      — hooks (session.created, tool.execute.before/after)
    package.json  — plugin metadata
tools/
  memory.ts         — tool definition
  memory_search.ts  — tool definition
```

## License

MIT
