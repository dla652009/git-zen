---
name: git-commit-message
description: Generate concise, accurate Git commit messages from repository changes, using staged changes first and the repository's existing commit conventions when available.
---

# Git Commit Message

Use this skill when the user asks for a commit message, wants a change summarized for Git, or asks to format a commit according to the repository convention. The goal is to describe the actual change clearly and briefly; do not create the commit unless the user separately asks for that mutation.

## Inspect the change

1. Confirm the working directory is inside a Git repository. If it is not, say so and ask for the repository or the relevant diff.
2. Read `git status --short`.
3. Prefer the staged diff (`git diff --cached`). If nothing is staged, use the unstaged diff (`git diff`); include untracked files only when their contents are available and materially affect the change.
4. Inspect a small sample of recent commits (`git log -n 10 --oneline`) to infer the repository's message style. Look for a project-local convention in files such as `CONTRIBUTING.md`, `AGENTS.md`, or `.gitmessage` when present.
5. Base the message on the diff, not on filenames alone. Identify the primary user-visible or maintenance intent, and avoid claiming behavior that the change does not implement.

If there are both staged and unstaged changes, make clear which set the proposed message describes. If there is no diff to inspect, report that there are no committed changes to summarize and do not invent a message.

## Write the message

- Match the repository's established style when one is evident; otherwise use Conventional Commits when it fits naturally: `type(scope): imperative summary`.
- Choose a type that reflects intent, such as `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, `perf`, or `chore`. Do not force a type or scope when the project does not use them.
- Keep the subject concise, specific, and in the imperative mood. Avoid a trailing period, vague phrases such as “update stuff,” and implementation details that do not help identify the change.
- For a multi-part change, add a short body only when it explains important context, behavior, compatibility, or migration impact that the subject cannot convey. Wrap body lines reasonably and keep the body factual.
- Preserve required issue or ticket references if the repository convention or user provides them.
- Match the user's requested language when explicit. Otherwise follow the repository's dominant commit-message language; if no convention is evident, prefer concise English.

## Respond

Return one recommended message first, in a fenced `text` block so it can be copied directly. If useful, include up to two alternatives with a one-line reason for each. Briefly state the evidence used (for example, staged diff and recent commit style), but do not dump the full diff.

Never run `git commit`, amend, push, reset, checkout, or other repository-mutating commands as part of this skill. If the user asks to commit after reviewing the message, treat that as a separate explicit request and confirm the exact message and intended scope before committing.
