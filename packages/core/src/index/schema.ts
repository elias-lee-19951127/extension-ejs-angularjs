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
 */
export const PARSER_VERSION = 11;

/** Cache file name inside the .ejsng-cache/ directory. */
export const INDEX_FILENAME = 'index.ndjson';
