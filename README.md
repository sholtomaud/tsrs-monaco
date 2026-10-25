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
- **Persistence.** Files are saved to `localStorage`; Reset restores the example project.

## Source layout

```
src/
├── compiler/
│   ├── compiler.worker.ts   # runs @tsrs/wasm
│   ├── compiler-client.ts   # promise wrapper, restarts the worker if it crashes
│   ├── diagnostics.ts       # tsrs diagnostics → Monaco ranges
│   └── project.ts           # the virtual project and its default files
├── runtime/
│   ├── run.worker.ts        # executes emitted modules, forwards console output
│   ├── module-graph.ts      # links modules as Blob URLs, dependencies first
│   ├── format.ts            # console argument formatting
│   └── runner.ts            # one worker per run, stop()
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
| `npm run e2e` | Playwright tests against the dev server and the production build |

Requires Node.js 25+ (as Boba does). Pushes to `main` run CI and deploy `dist/` to GitHub Pages.

## Limits

- The wasm build is single-threaded; each instance has at most 4 GiB of linear memory (wasm32).
- npm packages are not resolved. Add declarations for an import as a `.d.ts` file under `src/`; absolute URL imports
  (e.g. `https://esm.sh/...`) are left as-is at runtime.
- Circular imports between project files are not supported by the Blob URL linker.

## License

MIT
