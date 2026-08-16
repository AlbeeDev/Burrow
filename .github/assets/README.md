# README assets

Images the README points at. PNGs are ignored repo-wide by default and this directory is one of the
three exceptions, so a screenshot has to be put here deliberately.

`banner.png` is generated, not drawn. Edit `banner.html`, then:

```sh
node render-banner.mjs
```

It screenshots the page at 2x using the app's own palette and fonts, read from `app/src/index.css`
and `app/node_modules`, so the banner cannot drift away from what the product looks like.

Playwright is not a repo dependency. Install it in a scratch directory once:

```sh
npm i playwright && npx playwright install chromium
```

Still wanted:

- `screen.png`, a file pushed onto the screen beside the terminal
- a GIF of a session surviving a device change, which is the claim words are worst at

Shoot them on an install with no real project names in it.
