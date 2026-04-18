# Office document generation

ohwow exposes a single MCP tool, `ohwow_generate_document`, that routes by `format` to four dispatchers: `pdf`, `pptx`, `xlsx`, and `docx`. The PDF path fills existing templates via `fill-pdf`; the other three build documents from scratch using `pptxgenjs`, `exceljs`, and `docx` respectively. Every generator returns native base64 inline on the response, and every generator honours `auto_save: true`, which writes the buffer under the workspace data directory and inserts an `agent_workforce_attachments` row so the file shows up in the dashboard. Tracked in the research backlog under [gap 01](../../research/gaps-to-close/01-office-document-skills.md).

## Format matrix

| Format | Action type      | Builder library | Response field   | Inline MIME                                                                 |
| ------ | ---------------- | --------------- | ---------------- | --------------------------------------------------------------------------- |
| pdf    | `fill_pdf`       | `pdf-lib`       | `pdf_base64`     | `application/pdf`                                                           |
| pptx   | `generate_pptx`  | `pptxgenjs`     | `pptx_base64`    | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| xlsx   | `generate_xlsx`  | `exceljs`       | `xlsx_base64`    | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`         |
| docx   | `generate_docx`  | `docx`          | `docx_base64`    | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`   |

All four also return `warnings: string[]`, plus `attachment_id`, `storage_path`, `storage_target`, `filename`, and `mime_type` when `auto_save: true` succeeded.

## Spec shapes

```ts
// PPTX
interface PptxSlideSpec {
  title?: string;
  bullets?: string[];
  notes?: string;
  layout?: 'TITLE' | 'TITLE_AND_CONTENT' | 'BLANK';
}
interface PptxSpec {
  title?: string;
  author?: string;
  slides: PptxSlideSpec[];
  filename?: string;
  auto_save?: boolean;
}
```

```ts
// XLSX
type XlsxCellValue = string | number | boolean | Date | null;
interface XlsxSheetSpec {
  name: string;
  headers?: string[];
  rows: XlsxCellValue[][];
  column_widths?: number[];
}
interface XlsxSpec {
  title?: string;
  author?: string;
  sheets: XlsxSheetSpec[];
  filename?: string;
  auto_save?: boolean;
}
```

```ts
// DOCX
interface DocxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}
type DocxBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'paragraph'; runs: DocxRun[] }
  | { type: 'bullets'; items: string[] };
interface DocxSpec {
  title?: string;
  author?: string;
  blocks: DocxBlock[];
  filename?: string;
  auto_save?: boolean;
}
```

## Example invocations

PPTX, with auto-save so the deck lands as a workspace attachment:

```json
{
  "tool": "ohwow_generate_document",
  "arguments": {
    "format": "pptx",
    "spec": {
      "title": "Q2 review",
      "author": "ohwow",
      "slides": [
        { "title": "Numbers", "bullets": ["MRR up 18 percent", "Churn flat"] },
        { "title": "What we ship next", "bullets": ["Office skills", "Video pipeline"] }
      ],
      "auto_save": true,
      "filename": "q2-review.pptx"
    }
  }
}
```

Response carries `pptx_base64`, `slide_count`, and on success also `attachment_id`, `storage_path`, `filename`, `mime_type`.

XLSX, inline only, no auto-save:

```json
{
  "tool": "ohwow_generate_document",
  "arguments": {
    "format": "xlsx",
    "spec": {
      "title": "Pipeline snapshot",
      "sheets": [
        {
          "name": "Deals",
          "headers": ["account", "stage", "amount"],
          "rows": [
            ["Acme", "negotiation", 24000],
            ["Globex", "proposal", 9000]
          ],
          "column_widths": [24, 16, 12]
        }
      ]
    }
  }
}
```

Response has `xlsx_base64`, `sheet_count`, `row_count`.

DOCX, with auto-save:

```json
{
  "tool": "ohwow_generate_document",
  "arguments": {
    "format": "docx",
    "spec": {
      "title": "Meeting notes",
      "blocks": [
        { "type": "heading", "level": 1, "text": "Weekly sync" },
        {
          "type": "paragraph",
          "runs": [
            { "text": "Decisions from the ", "bold": false },
            { "text": "engineering", "bold": true },
            { "text": " track:" }
          ]
        },
        { "type": "bullets", "items": ["Ship gap 01", "Start gap 02"] }
      ],
      "auto_save": true,
      "filename": "weekly-sync.docx"
    }
  }
}
```

Response has `docx_base64`, `block_count`, and on auto-save the same `attachment_id` / `storage_path` / `filename` / `mime_type` fields as the other formats.

## Deck-from-research-thread walkthrough

A common pattern: an agent runs a long research thread, a handful of tool calls deep, and ends up with a mental model it needs to hand back to a human. The orchestrator distills that thread into four to six outline blocks — one slide per block — then calls `ohwow_generate_document` with `format: 'pptx'`, `auto_save: true`, and the built `PptxSpec`. The response carries `attachment_id`, `storage_path`, and `filename`; the dashboard surface renders that as a download link next to the chat turn, and the attachment is retrievable over the standard `/documents` API afterwards.

Concretely, a three-slide deck distilled from a competitive-landscape thread looks like this:

```json
{
  "title": "Competitive landscape, April",
  "author": "ohwow research agent",
  "slides": [
    {
      "title": "Who is in this space",
      "bullets": [
        "Local-first runtimes: ohwow, Ollama plus custom wrappers",
        "Cloud IDEs with agent mode: three entrants since January",
        "Vertical SaaS shipping 'agents' as features, not products"
      ],
      "notes": "Pulled from seven forum threads and two analyst posts."
    },
    {
      "title": "What makes ohwow different",
      "bullets": [
        "Runs offline, one binary per workspace",
        "Multi-workspace parallel daemons, not containers",
        "MCP tools are the product surface, not a plugin layer"
      ]
    },
    {
      "title": "Where we are weak",
      "bullets": [
        "No hosted runtime SKU yet, gap 08",
        "Mobile client is still just a chat shell, gap 04",
        "Office document primitives shipped this week, gap 01"
      ]
    }
  ],
  "auto_save": true,
  "filename": "competitive-landscape-april.pptx"
}
```

## Limitations

- PPTX rich layouts beyond `TITLE`, `TITLE_AND_CONTENT`, and `BLANK` are not wired up yet.
- PPTX speaker notes are supported; animations, transitions, and embedded media are not.
- XLSX charts, pivot tables, and formulas are not yet exposed through the spec.
- DOCX tables, inline images, headers, footers, and table of contents are not yet exposed through the spec.
- There is no cross-format skill registry for template packs; that work lives in [gap 07](../../research/gaps-to-close/07-yaml-iac-config.md).

## References

- `src/triggers/dispatchers/fill-pdf.ts`
- `src/triggers/dispatchers/generate-pptx.ts`
- `src/triggers/dispatchers/generate-xlsx.ts`
- `src/triggers/dispatchers/generate-docx.ts`
- `src/mcp-server/tools/documents.ts`
- `src/api/routes/documents.ts`
