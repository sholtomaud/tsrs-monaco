import { CompilerClient } from './compiler-client.ts';

let client: CompilerClient | null = null;

/** One compiler worker for the whole app, so tsrs.wasm is fetched once. */
export function getCompiler(): CompilerClient {
  client ??= new CompilerClient();
  return client;
}
