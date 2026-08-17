/**
 * In-process change receipt API.
 *
 * The executable change-receipt.ts module re-exports this API for callers that
 * need the CLI contract, while production code and ordinary tests can avoid a
 * subprocess boundary.
 */
export { createReceipt, safePaths } from "./change-receipt.js";
