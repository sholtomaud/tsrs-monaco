# tsrs × Monaco

A TypeScript playground that type checks, compiles and runs TypeScript **entirely in the browser**, using
[`@tsrs/wasm`](https://www.npmjs.com/package/@tsrs/wasm) (tsrs, a Rust port of the TypeScript 7 compiler, built for
WebAssembly) inside [Monaco Editor](https://microsoft.github.io/monaco-editor/). Built with the
[Boba](https://github.com/sholtomaud/boba) framework: Custom Elements, a tiny router and an `EventTarget` store.

Background: [Cloudflare's TypeScript compiler in Rust](https://socket.dev/blog/cloudflare-typescript-rust).

## How it works

```
[ Monaco Editor ]  one model per file: tsconfig.json, src/index.ts, src/greet.ts, …
       │  (1) project files (debounced 400 ms)
       ▼
[ compiler.worker ]  tsc(["-p", "/project/tsconfig.json"], { files, diagnostics: "json" })
       │  (2) JSON diagnostics ──► Monaco markers (squiggles) + Problems panel
       │  (3) emitted dist/*.js ──► JavaScript tab
       ▼
[ run.worker ]  (4) each module → Blob URL (relative imports rewritten), then import(entry)
                    console.* is forwarded back to the Console panel
```

- **Real tsrs API.** `@tsrs/wasm` exposes `tsc(args, options)`, the same command line as `tsc`, over an in-memory
  file system. The playground passes the whole virtual project, including an editable `tsconfig.json`, and reads
  back `result.diagnostics` (UTF-16 positions) and `result.files` (emitted JavaScript). The TypeScript `lib.*.d.ts`
  files are bundled inside `tsrs.wasm`.
- **Off the main thread.** The compiler runs in a module worker (the checker recurses deeply, and a slow check never
  blocks typing). `tsrs.wasm` (~9.8 MB, ~2.9 MB gzipped) is compiled once and instantiated fresh for each check.
- **No Monaco TypeScript service.** Only Monaco's core editor, everyday features and syntax highlighting are loaded,
  so every diagnostic comes from tsrs.
- **Sandboxed execution.** Each Run starts a new worker. Stop (or the next Run) terminates it, so an infinite loop
  never freezes the page. Code runs in a worker, so the default `lib` is `esnext` + `webworker` (no DOM).
- **Tests and plots.** User code gets three globals, typed in each example's `src/playground.d.ts`: `plot()` draws a
  line chart in the Plot panel, and `test()` / `expect()` (a Jest-style subset) register tests that **Test**
  (Ctrl/⌘ + Shift + Enter) runs from every `src/**/*.test.ts`.
- **Examples.** *Hello, types*; *npm: ONNX Runtime Web* (builds a tiny ONNX model in memory and runs it);
  *npm: TensorFlow.js + WebGPU* (fits a line with SGD on WebGPU, falling back to the CPU backend); and
  *Odum: CASH money storage*, a port of H.T. Odum's BASIC minimodel
  (Table I-5): one storage with constant inflow `J` and outflow `K*M`, integrated with Euler's method, with tests
  against its steady state `J/K` and exact solution. `npm test` compiles every example with the real `@tsrs/wasm`
  and runs its tests, so a broken example fails CI. The npm examples need the network, so they are checked by
  `LIVE_CDN=1 npx playwright test e2e/npm-examples.live.spec.ts` instead; the regular e2e suite tests npm support
  against a mocked CDN.
- **npm packages.** Type `import * as ort from 'onnxruntime-web'` and it just works:
  - *Types:* the playground resolves the version on jsDelivr, then follows the package's declaration files
    (relative imports, other packages, `/// <reference>`, falling back to `@types/*`) and fetches only the `.d.ts`
    files the import reaches. They're handed to tsrs as `node_modules/`, so it type checks your code against them.
  - *Runtime:* each bare import in the emitted JavaScript is rewritten to a URL. If the package's browser ES module
    is a self-contained bundle (onnxruntime-web), it loads straight from jsDelivr, so assets it finds with
    `import.meta.url`, like its `.wasm`, load from next to it. Otherwise it loads through esm.sh (tfjs), which
    resolves the package's own dependencies so packages share one copy of, e.g., `@tensorflow/tfjs-core`. The
    Console lists where each import came from.
  - Add a root `package.json` (via **+**) with `dependencies` to pin versions; otherwise imports use `latest`.
    Types and runtime always use the same resolved version.
- **Web apps (Preview).** A project with an `index.html` is a web app: Run serves it in the **Preview** tab
  instead of a worker. The *Web app: Boba template* example is [Boba's app
  template](https://github.com/sholtomaud/boba/tree/main/template), type checked by tsrs. A service worker
  (`public/preview-sw.js`) serves `preview/app/` from the Cache API, standing in for Vite: `src/a.ts` is served
  as its emitted JavaScript (at `src/a.ts` and `src/a.js`), `public/` at the root, `?raw` imports as string
  modules, and `import './a.css'` as a module that adds the stylesheet. Tailwind is compiled in the page by
  `@tailwindcss/browser`, served from the playground. The app's console output and load errors appear in the
  Console. Regenerate the example with `node scripts/sync-boba-example.mjs path/to/boba/template`.
- **Persistence.** Files are saved to `localStorage`; Reset restores the current example.

## Source layout

```
src/
├── compiler/
│   ├── compiler.worker.ts   # runs @tsrs/wasm
│   ├── compiler-client.ts   # promise wrapper, restarts the worker if it crashes
│   ├── diagnostics.ts       # tsrs diagnostics → Monaco ranges
│   └── project.ts           # the virtual project and its default files
├── preview/
│   ├── site.ts              # a web app project → the files the Preview serves
│   └── preview-client.ts    # registers public/preview-sw.js, publishes to the Cache API
├── runtime/
│   ├── run.worker.ts        # executes emitted modules, forwards console output
│   ├── module-graph.ts      # links modules as Blob URLs, dependencies first
│   ├── format.ts            # console argument formatting
│   ├── expect.ts            # expect() matchers for user tests
│   ├── chart.ts             # plot() data and SVG rendering
│   └── runner.ts            # one worker per run, stop()
├── packages/                # npm: type acquisition, CDN URLs, package.json resolution
├── examples/                # example projects (+ a test that compiles and runs them)
├── editor/monaco.ts         # Monaco set-up (features, languages, workers, theme)
├── store/playground-store.ts
└── components/
    ├── playground-page/     # editor, file tabs, Console / JavaScript / Problems
    ├── about-page/          # "How it works"
    └── nav-page/
```

## Scripts

| Script | Description |
| --- | --- |
| `npm start` / `npm run dev` | Vite dev server |
| `npm run build` | Production build into `dist/` |
| `npm test` | Unit tests (`node --test`, run directly on TypeScript) |
| `npm run typecheck` | Type check with TypeScript 7 (`tsc -p .`) |
| `npm run lint` | Lint with [oxlint](https://oxc.rs/docs/guide/usage/linter) |
| `npm run e2e` | Playwright tests against the dev server and the production build |

Requires Node.js 25+ (as Boba does). Pushes to `main` run CI and deploy `dist/` to GitHub Pages.

## Limits

- The wasm build is single-threaded; each instance has at most 4 GiB of linear memory (wasm32).
- npm packages need the network (jsDelivr for types and bundles, esm.sh for everything else), and a package's
  first type fetch can take a few seconds (tfjs-core is ~300 small `.d.ts` files; they're cached by the browser
  afterwards). Libraries that need the DOM won't work, because code runs in a worker. Multi-threaded wasm (e.g.
  ONNX Runtime threads) needs a cross-origin isolated page, which GitHub Pages can't provide.
- Circular imports between project files are not supported by the Blob URL linker.
- The Preview runs on the playground's origin (its service worker must control the frame), so an app there can
  reach the playground's page and storage. It doesn't load npm packages yet, and it needs HTTPS or localhost.

## License

MIT
