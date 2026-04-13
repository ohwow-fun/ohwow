-- Archive all active procedure skills.
--
-- Context: the runtime's three keyword matchers (runAgent SOP loop,
-- engine compileSkills, prompt-builder triggerMatched) were removed
-- in the unified-skill-synthesis refactor. Procedure rows no longer
-- have any discovery path at runtime. Setting is_active=0 archives
-- them without losing the audit trail. Rows remain queryable for
-- historical analysis but stop appearing in the skill loader's
-- boot scan and the now-deleted matchers.
--
-- The three active rows on launch eve were all degenerate single-
-- tool wrappers:
--   - "Post a Tweet"       → tool_sequence ["x_compose_tweet"]
--   - "Write X Article"    → tool_sequence ["x_compose_article"]
--   - "Check X Messages"   → tool_sequence ["x_list_dms"]
-- The LLM already has x_compose_tweet, x_compose_article, and
-- x_list_dms directly in its static tool list. No capability is lost.
--
-- The single inactive desktop SOP ("Check X Notifications") is
-- already is_active=0 and is unaffected.
--
-- Idempotent: safe to re-run. The `updated_at` stamp moves on each
-- run but no functional state changes after the first application.

UPDATE agent_workforce_skills
   SET is_active = 0,
       updated_at = datetime('now')
 WHERE skill_type = 'procedure'
   AND is_active = 1;
