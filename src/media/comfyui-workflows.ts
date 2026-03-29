/**
 * ComfyUI Workflow Templates
 *
 * Pre-built workflow JSON structures for common generation tasks.
 * These are minimal node graphs that ComfyUI can execute.
 */

/**
 * Text-to-image workflow using a standard checkpoint model.
 * Compatible with SD 1.5, SDXL, and Flux models.
 */
export function textToImageWorkflow(opts: {
  prompt: string;
  negativePrompt?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
}): Record<string, unknown> {
  const {
    prompt,
    negativePrompt = '',
    model = 'sd_xl_base_1.0.safetensors',
    width = 1024,
    height = 1024,
    steps = 20,
    cfg = 7,
    seed = Math.floor(Math.random() * 2 ** 32),
  } = opts;

  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: model },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['1', 1] },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: negativePrompt, clip: ['1', 1] },
    },
    '4': {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: 1 },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
        seed,
        steps,
        cfg,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1.0,
      },
    },
    '6': {
      class_type: 'VAEDecode',
      inputs: { samples: ['5', 0], vae: ['1', 2] },
    },
    '7': {
      class_type: 'SaveImage',
      inputs: { images: ['6', 0], filename_prefix: 'ohwow' },
    },
  };
}

/**
 * Image-to-image workflow (takes an existing image and modifies it).
 */
export function imageToImageWorkflow(opts: {
  prompt: string;
  negativePrompt?: string;
  model?: string;
  imageBase64: string;
  denoise?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
}): Record<string, unknown> {
  const {
    prompt,
    negativePrompt = '',
    model = 'sd_xl_base_1.0.safetensors',
    imageBase64,
    denoise = 0.7,
    steps = 20,
    cfg = 7,
    seed = Math.floor(Math.random() * 2 ** 32),
  } = opts;

  return {
    '1': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: model },
    },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['1', 1] },
    },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: negativePrompt, clip: ['1', 1] },
    },
    '4': {
      class_type: 'LoadImageBase64',
      inputs: { image: imageBase64 },
    },
    '5': {
      class_type: 'VAEEncode',
      inputs: { pixels: ['4', 0], vae: ['1', 2] },
    },
    '6': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['5', 0],
        seed,
        steps,
        cfg,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise,
      },
    },
    '7': {
      class_type: 'VAEDecode',
      inputs: { samples: ['6', 0], vae: ['1', 2] },
    },
    '8': {
      class_type: 'SaveImage',
      inputs: { images: ['7', 0], filename_prefix: 'ohwow-i2i' },
    },
  };
}
