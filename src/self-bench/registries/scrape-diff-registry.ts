/**
 * scrape-diff-registry — seed list of external surfaces the market-
 * radar probes watch.
 *
 * Each row becomes one ScrapeDiffProbeExperiment instance via
 * auto-registry.ts. Add a row to watch a new surface; no new TS file
 * required.
 *
 * Identity / ledger continuity
 * ----------------------------
 * Each row's `id` is stable — changing it orphans historical findings
 * for that subject. Rename the name/hypothesis freely; never rename
 * the id once it has fired in production.
 *
 * X/Twitter search pages are intentionally excluded. Scrapling's
 * stealth tiers don't reliably bypass X's auth'd DOM, and X already
 * has dedicated coverage via the x-ops-observer / x-dm / x-compose
 * stack. Revisit once we have a CDP-lane-backed scraper for auth'd
 * surfaces.
 */

import type { ScrapeDiffProbeConfig } from '../experiments/scrape-diff-probe.js';

export const SCRAPE_DIFF_REGISTRY: readonly ScrapeDiffProbeConfig[] = [
  // Competitor pricing pages — drift here is a direct market signal.
  {
    id: 'scrape-diff:linear-pricing',
    name: 'Linear pricing drift',
    url: 'https://linear.app/pricing',
    subjectKey: 'market:linear.app/pricing',
    category: 'business_outcome',
    hypothesis: 'Linear adjusts pricing / plan tiers in ways worth noticing.',
  },
  {
    id: 'scrape-diff:n8n-pricing',
    name: 'n8n pricing drift',
    url: 'https://n8n.io/pricing',
    subjectKey: 'market:n8n.io/pricing',
    category: 'business_outcome',
    hypothesis: 'n8n adjusts pricing / plan tiers in ways worth noticing.',
  },
  // Direct-rival READMEs and release feeds — product drift signal.
  {
    id: 'scrape-diff:librechat-releases',
    name: 'LibreChat releases',
    url: 'https://github.com/danny-avila/LibreChat/releases',
    subjectKey: 'market:github.com/danny-avila/LibreChat/releases',
    category: 'business_outcome',
    hypothesis: 'LibreChat ships features that reshape the local-AI stack.',
  },
  {
    id: 'scrape-diff:open-webui-readme',
    name: 'open-webui README',
    url: 'https://github.com/open-webui/open-webui',
    subjectKey: 'market:github.com/open-webui/open-webui',
    category: 'business_outcome',
    hypothesis: 'open-webui pivots in ways that redefine the local-AI landscape.',
  },
  // Research front-door — new agent / MCP papers land here.
  {
    id: 'scrape-diff:arxiv-cs-ai-new',
    name: 'arXiv cs.AI new submissions',
    url: 'https://arxiv.org/list/cs.AI/new',
    subjectKey: 'market:arxiv.org/list/cs.AI/new',
    category: 'business_outcome',
    hypothesis: 'New cs.AI submissions include agent / MCP signal worth chasing.',
  },
  // Discovery surfaces — what's trending in the local-first-AI conversation.
  {
    id: 'scrape-diff:producthunt-ai-topic',
    name: 'Product Hunt — AI topic',
    url: 'https://www.producthunt.com/topics/artificial-intelligence',
    subjectKey: 'market:producthunt.com/topics/artificial-intelligence',
    category: 'business_outcome',
    hypothesis: 'New AI launches on PH foreshadow market entrants worth knowing.',
  },
  {
    id: 'scrape-diff:hn-local-first-ai',
    name: 'HN — "local-first AI" last 24h',
    url: 'https://hn.algolia.com/?q=local-first+AI&dateRange=pastDay',
    subjectKey: 'market:hn.algolia.com/local-first-AI',
    category: 'business_outcome',
    hypothesis: 'HN conversation on local-first AI surfaces positioning signal.',
  },
];
