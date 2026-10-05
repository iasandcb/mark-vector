# vendor/

Third-party code committed as a build output rather than fetched at runtime.

## codemirror.js

CodeMirror 6, bundled into one ES module for `static/js/editor.js`.

**Why it's vendored instead of loaded from a CDN.** CodeMirror is several
packages that must all resolve to *one* copy of `@codemirror/state` — two
copies meet at runtime and the editor throws. jsDelivr's `/+esm` builds each
package with its own dependency copies (`codemirror` pulls state 6.5.2,
`@codemirror/language` pulls 6.7.0), so loading the pieces separately from
there cannot work. Bundling once fixes the versions and removes the runtime
dependency on a CDN for the editor itself.

Nothing about the app's no-build-step setup changes: this is a static file
the browser loads directly. It is only regenerated to upgrade CodeMirror.

**Versions in the current bundle** (esbuild 0.28.x, `--format=esm --minify --target=es2020`):

```
@codemirror/commands 6.11.1
@codemirror/language 6.12.4
@codemirror/search   6.7.2
@codemirror/state    6.7.5
@codemirror/view     6.43.12
codemirror           6.0.2
```

**To regenerate** (anywhere outside this repo, e.g. a temp directory):

```bash
npm init -y
npm i codemirror @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/search

cat > entry.js <<'JS'
export { EditorState, EditorSelection, Compartment, StateEffect } from "@codemirror/state";
export { EditorView, keymap, placeholder, drawSelection, highlightActiveLine } from "@codemirror/view";
export { defaultKeymap, history, historyKeymap, undo, redo } from "@codemirror/commands";
export { codeFolding, foldGutter, foldService, foldEffect, unfoldEffect, foldedRanges } from "@codemirror/language";
export { search, searchKeymap, openSearchPanel, closeSearchPanel, searchPanelOpen } from "@codemirror/search";
JS

npx esbuild entry.js --bundle --format=esm --minify --target=es2020 --outfile=codemirror.js
```

Then copy `codemirror.js` here and update the version list above. If
`editor.js` starts importing something new, add it to `entry.js` first —
anything not re-exported there isn't in the bundle.
