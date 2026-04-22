export type VideoProviderCreditTier = 'draft' | 'standard' | 'premium';
export type VideoProviderQuality = 'low' | 'medium' | 'high' | 'ultra';
export type VideoProviderSpeed = 'slow' | 'medium' | 'fast';
export type VideoProviderCapability =
  | 'text-to-video'
  | 'image-to-video'
  | 'avatar'
  | 'motion-brush';

/** Stable metadata about a video-generation provider. Mirrored in the runtime's video-clip-provider.ts. */
export interface VideoProviderMeta {
  id: string;
  name: string;
  creditTier: VideoProviderCreditTier;
  quality: VideoProviderQuality;
  speed: VideoProviderSpeed;
  /** Maximum supported clip length in seconds. */
  maxDuration: number;
  supportedAspectRatios: Array<'16:9' | '9:16' | '1:1'>;
  capabilities: VideoProviderCapability[];
  /** Lower = preferred in cost-aware routing. */
  priority: number;
}

/** Seedance / Bytedance 5-block cinematic prompt structure. */
export interface SeedancePromptBlock {
  subject: string;
  action: string;
  camera: string;
  style: string;
  qualitySuffix?: string;
}

/** Compose a Seedance 5-block prompt into a single string. */
export function composeSeedancePrompt(block: SeedancePromptBlock): string {
  const parts = [block.subject, block.action, block.camera, block.style];
  if (block.qualitySuffix) parts.push(block.qualitySuffix);
  return parts.filter(Boolean).join('. ');
}
