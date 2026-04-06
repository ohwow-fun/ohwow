/**
 * Doc Mounts — Barrel Exports
 */

export type {
  DocMount,
  DocMountPage,
  DocMountStatus,
  CrawlOptions,
  CrawledPage,
} from './types.js';

export { DocMountManager, type DocMountManagerConfig } from './mount-manager.js';
export { docMountExecutor } from './doc-mount-executor.js';
export {
  DOC_MOUNT_TOOL_DEFINITIONS,
  DOC_MOUNT_TOOL_NAMES,
  isDocMountTool,
  DOC_MOUNT_SYSTEM_PROMPT,
} from './doc-mount-tools.js';
export {
  normalizeUrlsToPaths,
  urlToNamespace,
  extractDomain,
} from './path-normalizer.js';
export {
  syncPeerMounts,
  listPeerMounts,
  removePeerMirrors,
} from './mesh-sync.js';
