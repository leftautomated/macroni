# AGENTS.md

Project instructions for AI coding agents.


## bruhs-managed

<!-- bruhs:state:begin v1 -->
<!-- AUTO-MAINTAINED BY /bruhs. Edits inside this block will be overwritten. Add hand-written rules outside the block. -->

### Project State (managed by /bruhs)

```json
{
  "integrations": {
    "linear": {
      "mcpServer": "linear-bnle",
      "team": "automated",
      "teamName": "automated",
      "project": "macroni",
      "projectName": "macroni",
      "labels": {
        "feat": "Feature",
        "fix": "Bug",
        "chore": "Chore",
        "refactor": "Improvement"
      }
    }
  },
  "tooling": {
    "mcps": [
      "hugging-face",
      "linear-bnle",
      "linear-perdix",
      "linear-shapens",
      "linear-sonner",
      "notion",
      "paper",
      "shadcn",
      "tldraw",
      "uidotsh",
      "vercel"
    ],
    "skills": [
      "superpowers",
      "feature-dev",
      "commit-commands",
      "shadcn",
      "rust-best-practices",
      "rust-async-patterns",
      "vercel-react-best-practices"
    ]
  },
  "stack": {
    "structure": "single",
    "framework": "Tauri 2 (Vite + React + Rust)",
    "styling": [
      "Tailwind CSS v4",
      "shadcn/ui"
    ],
    "database": [],
    "auth": null,
    "libraries": [
      "radix-ui",
      "class-variance-authority",
      "lucide-react",
      "clsx",
      "tailwind-merge"
    ],
    "state": null,
    "animation": null,
    "ai": null,
    "workers": null,
    "payments": null,
    "email": null,
    "testing": [
      "vitest",
      "@testing-library/react",
      "jsdom"
    ],
    "tooling": [
      "biome",
      "typescript",
      "pnpm",
      "vite"
    ],
    "infra": [
      "tauri"
    ],
    "gpu": [],
    "observability": [],
    "llmObservability": null,
    "notes": "Desktop app. Rust backend in src-tauri/ (scap capture, rdev input, h264 encoder). React frontend in src/. Team/project IDs are placeholders until Linear MCPs reconnect \u2014 re-run /bruhs:claim to wire real UUIDs."
  }
}
```

<!-- bruhs:state:end -->


## bruhs-managed

<!-- bruhs:rules:begin v1 -->
<!-- AUTO-MAINTAINED BY /bruhs. Edits inside this block will be overwritten. Add hand-written rules outside the block. -->

### Stack-Specific Rules (managed by /bruhs)

#### shadcn/ui
- Check `components/ui/` (or `packages/ui/`) before creating a new primitive — there's probably already one.
- Install components via the shadcn MCP / `pnpm dlx shadcn@latest add <name>`, never copy-paste manually.

#### Vitest
- Run `pnpm vitest run <file>` for single-file runs; reserve watch mode for local dev.

#### Biome
- Type-only imports require the `type` keyword: `import { type Foo } from 'x'`.
- Biome auto-sorts imports alphabetically within braces — don't fight it.
- Single quotes, no semicolons, 2-space indent.

<!-- bruhs:rules:end -->
