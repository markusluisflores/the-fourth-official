# Contributing to the-fourth-official

## Development Setup

```bash
git clone https://github.com/markusluisflores/the-fourth-official.git
cd the-fourth-official
npm install
npm run dev
```

## Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/<description>` | `feat/dark-mode` |
| Bug fix | `fix/<description>` | `fix/decimal-input` |
| Docs | `docs/<description>` | `docs/api-reference` |
| Chore | `chore/<description>` | `chore/update-deps` |

## Workflow

1. Branch from `main` — never commit directly to `main`
2. Write or update tests for any logic changes
3. Run `npm test` — all tests must pass before opening a PR
4. Open a PR using the provided template — fill in all sections
5. CI must be green before merge

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add currency swap button
fix: correct leading zero in numpad input
docs: update README with setup steps
chore: update Vite to v6
```

## Bug Reports

See [SECURITY.md](SECURITY.md) for security vulnerabilities.
For all other bugs, use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.yml) issue template.
Only file a bug if the defect was found after merge to main or a release — catch-during-development issues are fixed inline.

## Feature Requests

Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.yml) issue template.
