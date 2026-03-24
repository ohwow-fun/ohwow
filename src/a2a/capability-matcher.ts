/**
 * A2A Capability Matcher — Local Workspace
 *
 * Matches task descriptions to agent connections by skill tags and
 * keyword overlap. Same algorithm as the cloud version.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface CapabilityRequest {
  description: string;
  requiredTags?: string[];
}

export interface CapabilityMatch {
  connectionId: string;
  skillId: string;
  skillName: string;
  score: number;
  matchReasons: string[];
}

interface A2ASkillLocal {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

interface ConnectionWithSkills {
  id: string;
  skills: A2ASkillLocal[];
}

// ============================================================================
// TEXT HELPERS
// ============================================================================

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was',
  'not', 'but', 'all', 'any', 'each', 'our', 'your', 'their', 'its',
  'about', 'into', 'than', 'then', 'them', 'what', 'when', 'where',
]);

function extractTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function keywordOverlapScore(queryTerms: string[], docText: string): number {
  if (queryTerms.length === 0) return 0;
  const docTerms = new Set(extractTerms(docText));
  let matches = 0;
  for (const term of queryTerms) {
    if (docTerms.has(term)) matches++;
  }
  return matches / queryTerms.length;
}

// ============================================================================
// MATCHING
// ============================================================================

export function matchCapabilities(
  request: CapabilityRequest,
  connections: ConnectionWithSkills[],
): CapabilityMatch[] {
  const matches: CapabilityMatch[] = [];
  const queryTerms = extractTerms(request.description);

  for (const connection of connections) {
    for (const skill of connection.skills) {
      const reasons: string[] = [];
      let score = 0;

      if (request.requiredTags && request.requiredTags.length > 0 && skill.tags) {
        const skillTagSet = new Set(skill.tags.map((t) => t.toLowerCase()));
        let tagMatches = 0;
        for (const reqTag of request.requiredTags) {
          if (skillTagSet.has(reqTag.toLowerCase())) tagMatches++;
        }
        score += (tagMatches / request.requiredTags.length) * 0.3;
        if (tagMatches > 0) reasons.push(`${tagMatches} tag match${tagMatches > 1 ? 'es' : ''}`);
      }

      const descScore = keywordOverlapScore(queryTerms, skill.description) * 0.4;
      score += descScore;
      if (descScore > 0.05) reasons.push('description keywords match');

      if (skill.examples && skill.examples.length > 0) {
        const exScore = keywordOverlapScore(queryTerms, skill.examples.join(' ')) * 0.3;
        score += exScore;
        if (exScore > 0.05) reasons.push('example similarity');
      }

      score += keywordOverlapScore(queryTerms, skill.name) * 0.1;

      if (score > 0.05) {
        matches.push({
          connectionId: connection.id,
          skillId: skill.id,
          skillName: skill.name,
          score: Math.min(1, score),
          matchReasons: reasons,
        });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches;
}
