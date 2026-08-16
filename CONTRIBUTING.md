# Contributing

Burrow is young and deliberately small. Bug reports, fixes and small improvements are welcome; for
anything larger, open an issue first so the direction is agreed before the work.

## Running from source

```sh
git clone https://github.com/AlbeeDev/Burrow.git
cd Burrow
./install.sh
npm start
```

`npm install` rebuilds the frontend. For frontend work, `npm run dev` in `app/` gives hot reload;
the gateway runs from source through `tsx` with no build step.

## Before opening a PR

Run the gate. CI runs the same two things on every push:

```sh
cd server && npm run typecheck && npm test
cd app && npm run build
```

If you touched `server/src/claude.ts` or `server/src/terminal.ts`, also run `npm run harness` in
`server/`. It spawns real Claude sessions in an isolated tmux, so it needs a logged-in Claude CLI;
it never touches your live sessions.

## Conventions

- Comments state the constraint, not the story: what must stay true and why, in a sentence or two.
- Commit messages explain why a change is right, not what the diff already shows.
- Only pure logic with real stakes gets unit tests (path containment, delivery detection, the drain
  rules). UI and glue are covered by the typecheck, the build, and using the app.
