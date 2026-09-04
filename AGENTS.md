<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Collaboration preferences

- Communicate with the user in Traditional Chinese unless they request another language.
- Prefer direct, practical, evidence-backed answers. Clearly separate confirmed defects from hypotheses, data limitations, presentation issues, and optional improvements.
- For an authorized implementation task, proceed autonomously through inspection, implementation, and proportionate verification. Ask only when a missing choice would materially change the result or when additional authority is required.
- Preserve the user's existing structure and intent when improving files or workflows; avoid broad rewrites unless they are necessary or explicitly requested.
- When reporting analysis, lead with the conclusion and provide concrete file paths, affected behavior, and verification results.
- After completing an authorized implementation and its proportionate verification, automatically commit only the files belonging to that task, push the current branch, and run the repository's existing deployment workflow when available. Do not ask for a separate confirmation unless the user explicitly opts out or credentials, permissions, unresolved failures, or an ambiguous deployment target make the operation unsafe.
- Never include unrelated pre-existing working-tree changes in an automatic commit; report any files that must be left uncommitted.

## Imported Claude context

- Historical Claude-export context relevant to this repository is summarized in `docs/CLAUDE_CONTEXT_IMPORT.md`.
- Treat imported performance targets, strategy results, architecture descriptions, and tool availability as historical evidence, not current truth. Verify them against the repository and current data before acting.
- Do not copy raw Claude exports, account details, private conversations, credentials, or personal data into the repository.
