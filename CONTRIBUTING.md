# Contributing to Fan

Thank you for helping improve Fan-Browser-Agent. Small fixes, documentation improvements, provider compatibility updates, and focused feature proposals are all welcome.

## Before you start

- Search existing [issues](https://github.com/7757/Fan-Browser-Agent/issues) before opening a new one.
- Use a feature request before investing in a large behavioral or architectural change.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Never post API keys, login cookies, private page content, or unredacted logs.

## Set up the project

You need Python 3.11–3.13, Node.js 22.12 or later, `uv`, and `npm`.

```bash
git clone https://github.com/7757/Fan-Browser-Agent.git
cd Fan-Browser-Agent
npm run setup
npm run dev
```

Development data is stored under `~/.dev_fan` by default. Set `FAN_HOME` before launch if you need an isolated location.

## Make a focused change

Create a branch from the latest `main` and keep each pull request focused on one problem. Preserve local-only defaults and the authenticated loopback boundary between Electron, Python, and the browser runtime.

Do not commit generated installers, dependency directories, local configuration, logs, credentials, or user data.

## Check your change

Run the checks that match the files you changed:

```bash
npm --prefix apps/desktop run type-check
npm --prefix apps/desktop run lint
.venv/bin/python -m pytest
```

For visible desktop changes, also launch `npm run dev` and include a screenshot or short recording in the pull request.

## Open a pull request

Describe:

- the problem and the chosen solution;
- the affected components and user-visible behavior;
- the checks you ran;
- any known limitations or follow-up work.

By submitting a contribution, you agree that it may be distributed under the repository's license.
