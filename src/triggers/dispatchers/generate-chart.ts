/**
 * generate_chart dispatcher: render a Chart.js config as PNG via QuickChart.
 */

import type { ActionDispatcher, DispatcherDeps } from '../action-dispatcher.js';
import type { ExecutionContext, ActionOutput } from '../automation-types.js';
import { resolveContextTemplate } from '../field-mapper.js';
import { logger } from '../../lib/logger.js';

export const generateChartDispatcher: ActionDispatcher = {
  actionType: 'generate_chart',

  async execute(
    config: Record<string, unknown>,
    context: ExecutionContext,
    deps: DispatcherDeps,
  ): Promise<ActionOutput> {
    const mode = (config.mode as string) || 'manual';

    const dataTemplate = config.data_source as string;
    let rawData: unknown;
    if (dataTemplate) {
      const resolved = resolveContextTemplate(dataTemplate, context);
      try {
        rawData = JSON.parse(resolved);
      } catch {
        rawData = resolved;
      }
    }

    let chartConfig: Record<string, unknown>;

    if (mode === 'ai') {
      const instruction = (config.instruction as string) || 'Generate an appropriate chart for this data';
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic();
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `You are a data visualization assistant. Given the following data and instruction, generate a Chart.js configuration object.\n\nData:\n${JSON.stringify(rawData, null, 2)}\n\nInstruction: ${instruction}\n\nRespond with ONLY a valid JSON object that is a Chart.js config (with "type", "data", and optionally "options"). No markdown, no explanation.`,
        }],
      });

      const textBlock = response.content.find((b: { type: string }) => b.type === 'text') as { text: string } | undefined;
      if (!textBlock) throw new Error('AI returned no text response for chart config');
      try {
        chartConfig = JSON.parse(textBlock.text);
      } catch {
        throw new Error('AI generated invalid JSON for chart config');
      }
    } else {
      const chartType = (config.chart_type as string) || 'bar';
      const labelsTemplate = config.labels_source as string;
      const datasetLabel = (config.dataset_label as string) || 'Data';
      const colors = config.colors as string[] | undefined;

      let labels: string[] = [];
      let values: number[] = [];

      if (labelsTemplate) {
        const resolvedLabels = resolveContextTemplate(labelsTemplate, context);
        try {
          labels = JSON.parse(resolvedLabels);
        } catch {
          labels = resolvedLabels.split(',').map((s: string) => s.trim());
        }
      }

      if (Array.isArray(rawData)) {
        values = rawData.map((v) => Number(v) || 0);
        if (labels.length === 0) {
          labels = values.map((_, i) => `Item ${i + 1}`);
        }
      }

      const defaultColors = [
        '#4F46E5', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
        '#06B6D4', '#EC4899', '#14B8A6', '#F97316', '#6366F1',
      ];

      chartConfig = {
        type: chartType,
        data: {
          labels,
          datasets: [{
            label: datasetLabel,
            data: values,
            backgroundColor: colors || defaultColors.slice(0, values.length),
          }],
        },
        options: { plugins: { legend: { display: true } } },
      };
    }

    const width = (config.width as number) || 600;
    const height = (config.height as number) || 400;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const QuickChart = (await import('quickchart-js')).default as any;
    const chart = new QuickChart();
    chart.setConfig(chartConfig);
    chart.setWidth(width);
    chart.setHeight(height);
    chart.setBackgroundColor('#ffffff');
    chart.setFormat('png');

    const pngBuffer = Buffer.from(await chart.toBinary());

    const { writeFile, mkdir } = await import('fs/promises');
    const { join } = await import('path');

    const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data');
    const dir = join(dataDir, 'charts', deps.workspaceId);
    await mkdir(dir, { recursive: true });

    const filename = `chart-${Date.now()}.png`;
    const filePath = join(dir, filename);
    await writeFile(filePath, pngBuffer);

    logger.info(`[ActionExecutor] Chart generated: ${filePath} (${pngBuffer.length} bytes)`);
    return {
      chart_path: filePath,
      chart_type: (chartConfig.type as string) || 'bar',
      width,
      height,
      file_size: pngBuffer.length,
    };
  },
};
