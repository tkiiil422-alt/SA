# superagent

TypeScript foundation for a self-hosted agent system. The domain kernel
(`src/core/`), policy/admission/limits, text helpers, and the core kernel tests
are ported from the MIT-licensed prototype
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
(commit `8c32a9d`). See `THIRD_PARTY_NOTICES.md` for attribution and the full
license text.

## Usage

```sh
pnpm install
pnpm check      # typecheck + tests
pnpm typecheck
pnpm test
```
