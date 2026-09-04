# Contributing to Strata

## Track work in GitHub Issues

Use [GitHub Issues](https://github.com/tylerstuff/strata/issues) for the backlog. Before starting a substantial change, create or select an issue with a concrete outcome and acceptance criteria. Keep scope changes, dependencies, benchmark evidence, and remaining work in that issue rather than a separate local task list.

Use `type:task` for planned work and `bug` for defects. Area labels identify the subsystem. Priorities mean:

- `priority:p0`: work needed to establish the foundation or unblock the next milestone.
- `priority:p1`: the next implementation or feasibility work.
- `priority:p2`: later work that depends on the foundation.

Milestones group outcomes; they do not imply release dates or proven feature support. Issues for research prototypes must distinguish measured results from targets.

## Branches and pull requests

Start from an up-to-date `main` and use `codex/<issue-number>-<short-description>` for working branches. Open a pull request linked to the issue, explaining the resulting behavior and relevant validation. Use `Closes #<number>` only when the change completes the issue's acceptance criteria; use `Refs #<number>` for partial work.

Keep generated assets, secrets, and local build outputs out of commits. Commit dependency lockfiles once package and toolchain setup exists. Do not publish npm packages or change repository visibility as an incidental part of implementation.

## Validation

Run checks appropriate to the change. The first runtime task will establish build, type-check, unit-test, package-consumer, and CI commands; none exist yet.

For performance-sensitive changes, record the device/GPU, OS, browser version, power conditions, internal rendering resolution, scene, camera path, warm-up, and measurement method. Distinguish CPU and GPU timings, include memory and startup costs where relevant, and test sustained moving scenes rather than only static screenshots. Describe target frame rates as targets until measured.

Package changes should be exercised through a packed consumer install, including WASM/worker asset resolution and initialization/disposal. The baseline must remain usable without shared-memory threading; a separately tested acceleration mode may use it where supported and configured.

## GitHub synchronization

The `origin` remote points to GitHub. Fetch and pull before beginning work, and push intended commits to the corresponding branch. A remote does not synchronize uncommitted files; there is no background auto-commit or auto-push process.
