/**
 * Media Generation Module
 *
 * Provides storage, routing, hardware detection, and local generation bridges
 * for multimodal media (images, video, audio, TTS, STT).
 */

export { saveMediaFile, saveMediaFromUrl, saveMediaBuffer, listMediaFiles, deleteMediaFile } from './storage.js';
export type { MediaType, MediaFileMetadata } from './storage.js';

export { routeMediaRequest, estimateMediaCost } from './media-router.js';
export type { MediaModality, MediaQuality, MediaRequest, MediaRoute } from './media-router.js';

export { probeMediaCapabilities } from './hardware-probe.js';
export type { MediaCapabilities } from './hardware-probe.js';

export { ComfyUIBridge } from './comfyui-mcp-bridge.js';
export { ComfyUIClient } from './comfyui-client.js';
export { textToImageWorkflow, imageToImageWorkflow } from './comfyui-workflows.js';

export { KokoroBridge } from './kokoro-mcp-bridge.js';
export { WhisperBridge } from './whisper-mcp-bridge.js';
