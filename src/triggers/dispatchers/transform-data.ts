/**
 * transform_data dispatcher: apply mappings with optional transforms.
 */

import type { ActionDispatcher } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput, TransformMapping } from '../automation-types.js';
import { resolveContextValue, applyTransform } from '../action-utils.js';
import { resolveContextTemplate } from '../field-mapper.js';

export const transformDataDispatcher: ActionDispatcher = {
  actionType: 'transform_data',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ActionOutput> {
    const mappings = config.mappings as TransformMapping[];
    if (!mappings || !Array.isArray(mappings)) {
      throw new Error('transform_data requires a mappings array in action_config');
    }

    const output: ActionOutput = {};

    for (const mapping of mappings) {
      let value: unknown;

      if (mapping.source.includes('{{')) {
        value = resolveContextTemplate(mapping.source, context);
      } else {
        value = resolveContextValue(mapping.source, context);
      }

      if (mapping.transform && value !== undefined) {
        value = applyTransform(value, mapping.transform);
      }

      if (value !== undefined) {
        output[mapping.target] = value;
      }
    }

    return output;
  },
};
