// Maps tsrs JSON diagnostics (0-based lines, UTF-16 columns) onto the
// 1-based ranges Monaco markers use. Kept free of Monaco imports so it can be
// unit tested under node --test.

import { toRelative } from './project.ts';

export interface Position {
  line: number;
  character: number;
}

export interface TsrsDiagnostic {
  fileName?: string;
  pos?: number;
  end?: number;
  startPosition?: Position;
  endPosition?: Position;
  code: number;
  category: number;
  text: string;
}

// TypeScript's DiagnosticCategory.
export const Category = {
  Warning: 0,
  Error: 1,
  Suggestion: 2,
  Message: 3,
} as const;

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface Problem {
  file: string | null;
  severity: Severity;
  code: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export function severityOf(category: number): Severity {
  switch (category) {
    case Category.Error:
      return 'error';
    case Category.Warning:
      return 'warning';
    case Category.Suggestion:
      return 'hint';
    default:
      return 'info';
  }
}

export function toProblem(d: TsrsDiagnostic): Problem {
  const start = d.startPosition ?? { line: 0, character: 0 };
  const end = d.endPosition ?? start;
  const empty = start.line === end.line && start.character === end.character;
  return {
    file: d.fileName ? toRelative(d.fileName) : null,
    severity: severityOf(d.category),
    code: d.code,
    message: d.text,
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    // Give zero-width diagnostics one character so the squiggle is visible.
    endColumn: end.character + (empty ? 2 : 1),
  };
}

export function formatProblem(p: Problem): string {
  const where = p.file ? `${p.file}:${p.startLineNumber}:${p.startColumn}` : '';
  return `${where}${where ? ' - ' : ''}${p.severity} TS${p.code}: ${p.message}`;
}
