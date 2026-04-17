import type { VideoBlock, BlockCategory } from "./types";
import { lowerThird } from "./lower-third";
import { statCard } from "./stat-card";
import { captionStrip } from "./caption-strip";
import { titleCard } from "./title-card";
import { quoteCard } from "./quote-card";
import { bulletList } from "./bullet-list";
import { metricDashboard } from "./metric-dashboard";
import { logoReveal } from "./logo-reveal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BLOCKS: readonly VideoBlock<any>[] = [
  titleCard,
  lowerThird,
  captionStrip,
  quoteCard,
  bulletList,
  statCard,
  metricDashboard,
  logoReveal,
];

export function getBlock(id: string): VideoBlock | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return BLOCKS.find(b => b.id === id) as VideoBlock<any> | undefined;
}

export function listBlocks(category?: BlockCategory): VideoBlock[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (category ? BLOCKS.filter(b => b.category === category) : [...BLOCKS]) as VideoBlock<any>[];
}

export { lowerThird, statCard, captionStrip, titleCard, quoteCard, bulletList, metricDashboard, logoReveal };
