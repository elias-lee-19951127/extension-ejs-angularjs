## Language policy

**Source code, tests, and commit messages in this repo are English by default.** This includes:

- Code comments and JSDoc/docstrings in `.ts`/`.js` files
- Identifiers where the name carries language (rare, but avoid new Vietnamese ones)
- Runtime-facing strings: LSP `reason`/`detail` text, hover content, CLI output, error
  messages — anything a user of the extension or CLI actually sees
- Test names (`test('...', ...)`) and assertion failure messages
- New git commit messages and PR descriptions

Vietnamese is welcome only as a secondary aid for readability — e.g. a short Vietnamese gloss
in parentheses next to a tricky English term, never as the primary language of a comment or
string.

**Exception — long-form project docs** (`CONTEXT.md`, `docs/kien-truc.md`): these
keep their existing Vietnamese version as the primary/canonical one (richer historical detail,
written for this project's Vietnamese-speaking maintainer). Add an English counterpart alongside
instead of replacing them — `CONTEXT.en.md`, `docs/architecture.md` (English
translation of `docs/kien-truc.md`). Keep both in sync when one changes meaningfully.

**README is the reverse:** `README.md` is English (it is what visitors see first on GitHub), and
`README.vi.md` is the Vietnamese version, linked from the top of `README.md`. Keep both in sync.

This policy governs artifacts written INTO the repository. It does not change what language
Claude uses when talking with the user in chat — follow the user's own language there as usual.

## Agent skills

### Issue tracker

Issue va spec luu duoi dang markdown trong `.scratch/<feature-slug>/` — repo local, chua co remote GitHub/GitLab. Xem `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: mot `CONTEXT.md` + `docs/adr/` duy nhat o goc repo. Xem `docs/agents/domain.md`.
