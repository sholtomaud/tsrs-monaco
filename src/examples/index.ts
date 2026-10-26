import type { ProjectFiles } from '../compiler/project.ts';
import * as bobaApp from './boba-app.ts';
import * as hello from './hello.ts';
import * as odumCash from './odum-cash.ts';
import * as onnxRuntime from './onnx-runtime.ts';
import * as tfjsWebgpu from './tfjs-webgpu.ts';

export interface Example {
  id: string;
  title: string;
  files: ProjectFiles;
}

export const EXAMPLES: Example[] = [
  { id: 'hello', title: 'Hello, types', files: hello.files },
  { id: 'odum-cash', title: 'Odum: CASH money storage', files: odumCash.files },
  { id: 'onnx-runtime', title: 'npm: ONNX Runtime Web', files: onnxRuntime.files },
  { id: 'tfjs-webgpu', title: 'npm: TensorFlow.js + WebGPU', files: tfjsWebgpu.files },
  { id: 'boba-app', title: 'Web app: Boba template (Preview)', files: bobaApp.files },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
