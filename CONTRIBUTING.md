# Contributing

How the repository works is in [AGENTS.md](AGENTS.md).

When starting a project from this template, follow the README's
[setup checklist](README.md#set-up-a-new-project): remove the example projects
and their workspace entries, scripts and CI steps; move the template README
to `vibespec/README.md` and retain its license with the toolchain; then write
the new project's root `README.md` and `LICENSE`. Check and review the initial
spec, commit all setup changes, and confirm `git status --short` is empty.

A change to `vibespec/` passes `npm run selftest`, with a new case for each new
kind of mistake it catches.
