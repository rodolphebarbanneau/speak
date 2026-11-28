# speak.brbnn.com

Speak's one-page site, on GitHub Pages. Plain HTML, CSS and JavaScript: no framework, no
dependencies, nothing loaded from another host (the font is served from `assets/fonts/`).

| File                  | What it is                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `index.html`          | The page                                                                                  |
| `assets/css/site.css` | brbnn.com's paper and ink for the page; Speak's own light and dark themes for its windows |
| `assets/js/site.js`   | The shortcuts and the download for the visitor's system, the demo                         |
| `assets/fonts/`       | JetBrains Mono, variable, Latin (from `@fontsource-variable/jetbrains-mono`), and its OFL |
| `assets/img/`         | The favicon, the touch icon and the social card                                           |
| `tools/build.mjs`     | Builds `_site/` for Pages, and serves it with `--serve`                                   |
| `tools/og.html`       | The social card's source: the command to render it again is at its top                    |

The page follows the visitor's light or dark setting. It reads well without its script: the
shortcuts are Windows and Linux ones, the download links open the latest release on GitHub,
and the demo shows its first example finished. With `prefers-reduced-motion`, the demo stands
still until the visitor presses play.

## Downloads

`tools/build.mjs` reads the latest release from GitHub and writes `_site/release.json`: each
installer's system, processor, kind, address and size. The page picks the visitor's own from
it, so it never calls GitHub itself. Without the file, every link opens the release page.

## Preview

```bash
node site/tools/build.mjs --serve   # http://localhost:8090/
```

## Deploy

`.github/workflows/site.yml` builds and deploys the site when `site/` changes on `main`, when a
release is published (the download links change), or by hand (**Actions → Site → Run
workflow**). On GitHub, a release that can't be read fails the build, so the live site never
loses its direct links. The custom domain is set in the repository's **Settings → Pages**,
and `speak.brbnn.com` is a `CNAME` to `rodolphebarbanneau.github.io` at the domain's DNS.
