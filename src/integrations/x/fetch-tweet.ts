/**
 * Fetch an X (Twitter) post's body + metadata without scraping the web UI.
 *
 * Uses Twitter's public syndication endpoint
 * (https://cdn.syndication.twimg.com/tweet-result) which returns a stable
 * JSON payload for any public tweet with no auth. This is the same endpoint
 * embed.twitter.com uses under the hood, so it's durable as long as tweet
 * embeds work on the web.
 *
 * Why this exists: `ohwow_scrape_url` does generic web scraping and falls
 * apart on X because the post body is rendered client-side. For DM drafting
 * and context-grounded outreach, we need the actual words a contact wrote,
 * not the accessibility tree of twitter.com. The x-authors-ledger records
 * only the permalink, not the body (v2 backlog item is snapshotting posts
 * into events at qualification time so the trail survives deletes).
 */

const SYNDICATION_BASE = 'https://cdn.syndication.twimg.com/tweet-result';

export interface XPostAuthor {
  handle: string;
  name: string | null;
  is_blue_verified: boolean;
  profile_image_url: string | null;
}

export interface XPostMedia {
  type: string | null;
  url: string | null;
  display_url: string | null;
  expanded_url: string | null;
}

export interface XPostMetrics {
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  bookmarks: number | null;
  views: number | null;
}

export interface XPost {
  id: string;
  permalink: string;
  text: string;
  display_text_range: [number, number] | null;
  created_at: string | null;
  lang: string | null;
  author: XPostAuthor;
  metrics: XPostMetrics;
  media: XPostMedia[];
  truncated: boolean;
}

/**
 * Extract a 64-bit tweet id from either a raw id or a permalink/URL.
 * Accepts: "2044523795206029525", "/handle/status/2044523795206029525",
 * "https://x.com/handle/status/2044523795206029525", "twitter.com/..." etc.
 */
export function extractTweetId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{5,25}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/status(?:es)?\/(\d{5,25})/);
  return m ? m[1] : null;
}

/**
 * Fetch a single X post. Returns null when the id can't be parsed or the
 * syndication endpoint returns a non-tweet response (private, deleted,
 * rate-limited). Throws on network errors so the caller can distinguish
 * "gone" from "unreachable".
 */
export async function fetchXPost(
  permalinkOrId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<XPost | null> {
  const id = extractTweetId(permalinkOrId);
  if (!id) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  // The `token` query param is required but its value is not validated —
  // any non-empty string works for unauthenticated lookups.
  const url = `${SYNDICATION_BASE}?id=${encodeURIComponent(id)}&token=a`;
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'ohwow-runtime/1.0 (+fetch-tweet)' },
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`syndication fetch failed: HTTP ${res.status}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  if (raw.__typename !== 'Tweet') return null;
  return mapSyndicationResponse(raw, id);
}

function mapSyndicationResponse(raw: Record<string, unknown>, id: string): XPost {
  const user = (raw.user ?? {}) as Record<string, unknown>;
  const handle = String(user.screen_name ?? '');
  const rangeRaw = raw.display_text_range;
  const range: [number, number] | null = Array.isArray(rangeRaw) && rangeRaw.length === 2
    ? [Number(rangeRaw[0]), Number(rangeRaw[1])]
    : null;
  const fullText = String(raw.text ?? '');
  // Display text strips trailing media URLs; prefer the range when present.
  const displayText = range ? fullText.slice(range[0], range[1]) : fullText;
  const truncated = range ? range[1] < fullText.length : false;

  const mediaRaw = Array.isArray(raw.mediaDetails) ? raw.mediaDetails as Array<Record<string, unknown>> : [];
  const media: XPostMedia[] = mediaRaw.map((m) => ({
    type: (m.type as string) ?? null,
    url: (m.media_url_https as string) ?? null,
    display_url: (m.display_url as string) ?? null,
    expanded_url: (m.expanded_url as string) ?? null,
  }));

  const metrics: XPostMetrics = {
    likes: numOrNull(raw.favorite_count),
    replies: numOrNull(raw.conversation_count ?? raw.reply_count),
    reposts: numOrNull(raw.retweet_count),
    bookmarks: numOrNull(raw.bookmark_count),
    views: numOrNull((raw as { view_count_info?: { count?: unknown } }).view_count_info?.count),
  };

  return {
    id,
    permalink: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
    text: displayText,
    display_text_range: range,
    created_at: (raw.created_at as string) ?? null,
    lang: (raw.lang as string) ?? null,
    author: {
      handle,
      name: (user.name as string) ?? null,
      is_blue_verified: Boolean(user.is_blue_verified),
      profile_image_url: (user.profile_image_url_https as string) ?? null,
    },
    metrics,
    media,
    truncated,
  };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
