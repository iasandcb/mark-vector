// The renderer that used to live here is now its own package:
//   https://github.com/iasandcb/asciimath-markdown
//
// This file stays as the one place that names a version, so app.js,
// public.js and glasses/app.js can go on importing "./markdown.js" (or
// "/static/js/markdown.js") and know nothing about where it comes from.
// Upgrading is a one-line edit here. The spoken-math converter behind math
// dictation (spokenMathToAsciiMath and friends) comes from the same package.
//
// jsDelivr's "/+esm" rewrites the package's own bare import of
// asciimath-parser into a CDN path (see the bundle header it serves), so
// this keeps mark-vector's no-build-step setup intact: the browser resolves
// everything by URL, exactly as it did when the renderer was a local file.
//
// KaTeX is still picked up from the global that index.html's <script> tag
// leaves behind - the package reads `globalThis.katex` per call unless a
// host hands it an instance with setKatex(), which nothing here needs to do.
export * from "https://cdn.jsdelivr.net/npm/asciimath-markdown@0.4.2/+esm";
