// Monaco without its bundled TypeScript language service: type checking and
// emit come from tsrs instead, so only the core editor, its everyday
// contributions and syntax highlighting are loaded.

import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/gotoError/register';
import 'monaco-editor/features/gotoLine/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/quickCommand/register';
import 'monaco-editor/features/suggest/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/yaml/register';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

// tsconfig.json allows comments.
jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: true,
  schemaValidation: 'ignore',
});

// VS Code's built-in themes, with the workbench's backgrounds (see
// playground-page.css) so the editor and its surroundings match.
monaco.editor.defineTheme('workbench-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#171184',
    'editorIndentGuide.background1': '#d3d3d3',
  },
});
monaco.editor.defineTheme('workbench-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1f1f1f',
    'editorGutter.background': '#1f1f1f',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#cccccc',
    'editorIndentGuide.background1': '#404040',
    'editorWidget.background': '#202020',
  },
});

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => monaco.editor.setTheme(dark.matches ? 'workbench-dark' : 'workbench-light');
dark.addEventListener('change', applyTheme);
applyTheme();

export { monaco };

export function languageOf(path: string): string {
  if (path.endsWith('.json')) return 'json';
  if (/\.(m|c)?tsx?$/.test(path)) return 'typescript';
  if (/\.(m|c)?jsx?$/.test(path)) return 'javascript';
  if (/\.html?$/.test(path)) return 'html';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.md')) return 'markdown';
  if (/\.ya?ml$/.test(path)) return 'yaml';
  if (path.endsWith('.svg')) return 'html';
  return 'plaintext';
}
