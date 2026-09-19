/**
 * Version of the fact-extraction logic. BUMP THIS NUMBER whenever an extractor's
 * behavior changes — every old record is then automatically treated as stale and
 * re-parsed.
 *
 * This is the only mechanism guarding against "stale cache" across extension
 * builds. During development there was one incident of forgetting to bump it:
 * `inferShape` was changed without bumping, and go-to-definition kept returning
 * the old position until this number was bumped.
 *
 * 11: fixed the one-character offset bug in attribute value spans (appendix I).
 * 12: JsFacts.templateLinks, and view/key spans on renderCalls (template-roots-config ticket 01).
 * 13: JsFacts.scopeWrites, and ValueShape.primitive (observed-types ticket 01).
 * 14: `var vm = this` aliases count as the controller in scopeMembers and scopeWrites.
 * 15: JsFacts.consoleCalls (observed-types-r1 ticket 02).
 * 16: ScopeWrite.lhsText and ScopeWrite.after (log-variable ticket 01).
 */
export const PARSER_VERSION = 16;

/** Cache file name inside the .ejsng-cache/ directory. */
export const INDEX_FILENAME = 'index.ndjson';
