import type { ProjectFiles } from '../compiler/project.ts';
import * as hello from './hello.ts';
import * as odumCash from './odum-cash.ts';

export interface Example {
  id: string;
  title: string;
  files: ProjectFiles;
}

export const EXAMPLES: Example[] = [
  { id: 'hello', title: 'Hello, types', files: hello.files },
  { id: 'odum-cash', title: 'Odum: CASH money storage', files: odumCash.files },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
