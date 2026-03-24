/**
 * Ambient type declarations for optional dependencies
 * that don't ship their own type definitions.
 *
 * These are dynamically imported at runtime with try/catch
 * so they're truly optional (not listed in package.json).
 */

declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
    text: string;
  }

  interface PdfParseOptions {
    max?: number;
    pagerender?: (pageData: unknown) => Promise<string>;
  }

  function pdfParse(buffer: Buffer, options?: PdfParseOptions): Promise<PdfParseResult>;
  export default pdfParse;
}
