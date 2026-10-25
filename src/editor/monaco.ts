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

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => monaco.editor.setTheme(dark.matches ? 'vs-dark' : 'vs');
dark.addEventListener('change', applyTheme);
applyTheme();

export { monaco };

export function languageOf(path: string): string {
  if (path.endsWith('.json')) return 'json';
  if (/\.(m|c)?tsx?$/.test(path)) return 'typescript';
  return 'javascript';
}
