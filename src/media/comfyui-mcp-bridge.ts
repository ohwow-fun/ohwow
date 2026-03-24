/**
 * ComfyUI MCP Bridge
 *
 * Wraps ComfyUI's REST API as an MCP stdio server, making local image/video
 * generation indistinguishable from cloud providers at the orchestrator level.
 *
 * Tools provided:
 * - generate_image: Text-to-image generation
 * - image_to_image: Modify an existing image with a prompt
 * - list_models: List available checkpoint models
 */

import { ComfyUIClient } from './comfyui-client.js';
import { textToImageWorkflow, imageToImageWorkflow } from './comfyui-workflows.js';
import { saveMediaBuffer } from './storage.js';
import { logger } from '../lib/logger.js';

export interface ComfyUIBridgeConfig {
  url?: string;
}

/**
 * ComfyUI bridge that exposes generation functions matching MCP tool signatures.
 * Not a full MCP stdio server — instead, registered as tool handlers in the orchestrator.
 */
export class ComfyUIBridge {
  private client: ComfyUIClient;

  constructor(config?: ComfyUIBridgeConfig) {
    this.client = new ComfyUIClient(config?.url);
  }

  async isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }

  /**
   * Generate an image from a text prompt.
   */
  async generateImage(params: {
    prompt: string;
    negative_prompt?: string;
    model?: string;
    width?: number;
    height?: number;
    steps?: number;
    seed?: number;
  }): Promise<{ path: string; message: string }> {
    const models = await this.client.listModels();
    const model = params.model ?? models[0];
    if (!model) {
      throw new Error('No checkpoint models found in ComfyUI. Install a model first.');
    }

    logger.info(`[comfyui-bridge] Generating image with model ${model}`);
    const workflow = textToImageWorkflow({
      prompt: params.prompt,
      negativePrompt: params.negative_prompt,
      model,
      width: params.width,
      height: params.height,
      steps: params.steps,
      seed: params.seed,
    });

    const results = await this.client.generate(workflow);
    if (results.length === 0) {
      throw new Error('ComfyUI returned no output images');
    }

    const saved = await saveMediaBuffer(results[0].buffer, 'image/png', 'comfyui');
    return {
      path: saved.path,
      message: `Image generated and saved to ${saved.path}`,
    };
  }

  /**
   * Modify an existing image with a text prompt.
   */
  async imageToImage(params: {
    prompt: string;
    negative_prompt?: string;
    image_base64: string;
    model?: string;
    denoise?: number;
    steps?: number;
  }): Promise<{ path: string; message: string }> {
    const models = await this.client.listModels();
    const model = params.model ?? models[0];
    if (!model) {
      throw new Error('No checkpoint models found in ComfyUI. Install a model first.');
    }

    const workflow = imageToImageWorkflow({
      prompt: params.prompt,
      negativePrompt: params.negative_prompt,
      model,
      imageBase64: params.image_base64,
      denoise: params.denoise,
      steps: params.steps,
    });

    const results = await this.client.generate(workflow);
    if (results.length === 0) {
      throw new Error('ComfyUI returned no output images');
    }

    const saved = await saveMediaBuffer(results[0].buffer, 'image/png', 'comfyui-i2i');
    return {
      path: saved.path,
      message: `Image generated and saved to ${saved.path}`,
    };
  }

  /**
   * List available models in ComfyUI.
   */
  async listModels(): Promise<string[]> {
    return this.client.listModels();
  }
}
