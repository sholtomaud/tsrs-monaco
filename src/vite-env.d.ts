/// <reference types="vite/client" />

interface Window {
  BOBA_BASE_URL: string;
}

interface ImportMetaEnv {
  /** The release a deploy publishes under v/<version>/ (set by deploy.yml). */
  readonly VITE_PLAYGROUND_VERSION?: string;
}
