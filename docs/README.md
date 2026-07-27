# docs/

Operator and contributor documentation lives at the repository root, because
that is where people look first:

| Question | File |
|---|---|
| What is this, how do I run it, how do I back it up? | [`../README.md`](../README.md) |
| How do I set up a dev environment and get a PR merged? | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| I found a vulnerability. | [`../SECURITY.md`](../SECURITY.md) |
| What changed? | [`../CHANGELOG.md`](../CHANGELOG.md) |
| Which environment variables exist? | [`../.env.example`](../.env.example) |
| What do the themes do? | [`../themes/README.md`](../themes/README.md) |

## history/

`history/` holds the original April 2026 design spec and implementation plan.
They are **superseded** — kept to explain how the product got here, not to be
implemented. Each file opens with a banner listing what it gets wrong (React 18
+ Zustand, Node 20, Express 4, Zod 3, three roles instead of four…).

When the code and a document disagree, the code wins, then the root `README.md`.
