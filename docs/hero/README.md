# The illustration at the top of the README

This folder holds the animation that opens the project's README, and what is needed to make it again.

It is an illustration, not a screenshot. The website in it ("Northwind") is made up. The card under
the code box is drawn with the colours, sizes and words the extension really uses
(`extension/content.js`), including the "Filled in" note it shows after a click. If the card changes
there, change it here too. A real screenshot of the card is in `docs/suggestion.png`.

| File | What it is |
| --- | --- |
| `hero.gif`, `hero-dark.gif` | The loop shown in the README, for GitHub's light and dark themes |
| `poster.png`, `poster-dark.png` | The same scene as a single still |
| `index.tsx`, `otp-bridge.css` | The scene itself |
| `export.mjs`, `capture.cjs` | Make the stills and the GIFs from the scene |
| `REHEARSAL.md` | How the scene was checked, and what was not checked |

## Making it again

The scene is built with Stageshow, an MIT-licensed kit for product illustrations. It is not part
of this repository, and nothing in OTP Bridge depends on it.

1. Copy `index.tsx` and `otp-bridge.css` into a folder named `examples/otp-bridge/` inside Stageshow.
2. In the Stageshow folder, install its tools and start its preview:

   ```sh
   npm install
   node node_modules/vite/bin/vite.js playground --config playground/vite.config.ts --port 5199
   ```

3. Open `http://127.0.0.1:5199/?capture=otp-bridge` to watch the scene.
4. In this folder, export the stills and the GIFs. `CHROME_PATH` is only needed when Google Chrome
   is not installed.

   ```sh
   export STAGESHOW_DIR=/path/to/stageshow
   node export.mjs .
   npm install --no-save gifenc pngjs
   node capture.cjs hero.gif
   node capture.cjs hero-dark.gif --dark
   ```

   The `npm install` line puts the two packages the GIF script needs into the project's
   `node_modules`, together with the project's own test tools (about 25 MB). It changes no file
   that is kept in the repository.

Run Stageshow's own checks before replacing the files; `REHEARSAL.md` lists the commands that
were run and what they reported.
