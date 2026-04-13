/**
 * PDF Form Orchestrator Tools
 * Inspect and fill AcroForm PDF fields programmatically.
 * Uses pdf-lib (pure JS, works in both cloud and local runtimes).
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalToolContext, ToolResult } from '../local-tool-types.js';
import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFDropdown,
  PDFRadioGroup,
  PDFSignature,
} from 'pdf-lib';

export const PDF_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'pdf_inspect_fields',
    description: 'Inspect an AcroForm PDF to list all fillable fields, their types, current values, and available options. Use this before filling a PDF form to understand its structure.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pdf_base64: { type: 'string', description: 'Base64-encoded PDF file to inspect.' },
      },
      required: ['pdf_base64'],
    },
  },
  {
    name: 'pdf_fill_form',
    description: 'Fill out an AcroForm PDF by setting field values. Returns the filled PDF as base64. Use pdf_inspect_fields first to discover field names and types.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pdf_base64: { type: 'string', description: 'Base64-encoded PDF file to fill.' },
        fields: {
          type: 'object',
          description: 'Map of field names to values. For text fields, provide a string. For checkboxes, provide "true" or "false". For dropdowns/radio groups, provide the option value.',
        },
        flatten: {
          type: 'boolean',
          description: 'If true, flatten the form after filling (fields become non-editable). Default: false.',
        },
      },
      required: ['pdf_base64', 'fields'],
    },
  },
];

/**
 * Inspect an AcroForm PDF to list all fillable fields.
 */
export async function pdfInspectFields(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const pdfBase64 = input.pdf_base64 as string | undefined;

  if (!pdfBase64) {
    return { success: false, error: 'pdf_base64 is required' };
  }

  try {
    const pdfDoc = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));

    let formType: 'acroform' | 'flat' = 'flat';
    const fields: Array<{
      name: string;
      type: string;
      currentValue: string | null;
      options?: string[];
    }> = [];

    try {
      const form = pdfDoc.getForm();
      const formFields = form.getFields();

      if (formFields.length > 0) {
        formType = 'acroform';

        for (const field of formFields) {
          const name = field.getName();
          let type = 'unknown';
          let currentValue: string | null = null;
          let options: string[] | undefined;

          if (field instanceof PDFTextField) {
            type = 'text';
            try { currentValue = field.getText() || null; } catch { /* empty */ }
          } else if (field instanceof PDFCheckBox) {
            type = 'checkbox';
            try { currentValue = String(field.isChecked()); } catch { /* empty */ }
          } else if (field instanceof PDFDropdown) {
            type = 'dropdown';
            try {
              const sel = field.getSelected();
              currentValue = sel.length > 0 ? sel[0] : null;
              options = field.getOptions();
            } catch { /* empty */ }
          } else if (field instanceof PDFRadioGroup) {
            type = 'radio';
            try {
              currentValue = field.getSelected() || null;
              options = field.getOptions();
            } catch { /* empty */ }
          } else if (field instanceof PDFSignature) {
            type = 'signature';
          }

          fields.push({ name, type, currentValue, ...(options ? { options } : {}) });
        }
      }
    } catch {
      // No form in PDF
    }

    return {
      success: true,
      data: { form_type: formType, field_count: fields.length, fields },
    };
  } catch (err) {
    return {
      success: false,
      error: `Couldn't inspect PDF: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/**
 * Fill out an AcroForm PDF by setting field values.
 */
export async function pdfFillForm(
  _ctx: LocalToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const pdfBase64 = input.pdf_base64 as string | undefined;
  const fieldValues = input.fields as Record<string, string> | undefined;
  const flatten = (input.flatten as boolean) ?? false;

  if (!pdfBase64) {
    return { success: false, error: 'pdf_base64 is required' };
  }
  if (!fieldValues || Object.keys(fieldValues).length === 0) {
    return { success: false, error: 'fields object is required and must not be empty' };
  }

  try {
    const pdfDoc = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));
    const form = pdfDoc.getForm();
    const fields = form.getFields();

    if (fields.length === 0) {
      return {
        success: false,
        error: 'This PDF has no fillable form fields. Use the PDF Tools converter to add fields first.',
      };
    }

    let fieldsFilled = 0;
    const warnings: string[] = [];

    for (const [name, value] of Object.entries(fieldValues)) {
      try {
        const field = form.getField(name);

        if (field instanceof PDFTextField) {
          field.setText(String(value));
          fieldsFilled++;
        } else if (field instanceof PDFCheckBox) {
          const shouldCheck = value === 'true' || value === '1' || value === 'yes';
          if (shouldCheck) field.check();
          else field.uncheck();
          fieldsFilled++;
        } else if (field instanceof PDFDropdown) {
          field.select(String(value));
          fieldsFilled++;
        } else if (field instanceof PDFRadioGroup) {
          field.select(String(value));
          fieldsFilled++;
        } else {
          warnings.push(`Field "${name}" has unsupported type`);
        }
      } catch (err) {
        warnings.push(
          `Couldn't fill "${name}": ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }

    if (flatten) {
      form.flatten();
    }

    const filledBytes = await pdfDoc.save();
    const filledBase64 = Buffer.from(filledBytes).toString('base64');

    return {
      success: true,
      data: { filled_pdf_base64: filledBase64, fields_filled: fieldsFilled, warnings },
    };
  } catch (err) {
    return {
      success: false,
      error: `Couldn't fill PDF form: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
