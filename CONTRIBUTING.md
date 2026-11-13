# Contributing

How the repository works is in [AGENTS.md](AGENTS.md); starting a project from the template is [README.md, "Set up a new project"](README.md#set-up-a-new-project).
A change to `vibespec/` passes `pnpm selftest`, with a new case for each new kind of mistake it catches.
Everything is built on [the stack](AGENTS.md#the-stack): Node 26, pnpm, VibeLang on Effect for the shell, React for every interface.
