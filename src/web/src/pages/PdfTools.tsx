import { useState, useCallback, useRef } from 'react';
import {
  UploadSimple,
  FilePdf,
  CircleNotch,
  ArrowLeft,
  DownloadSimple,
  ArrowClockwise,
  CaretLeft,
  CaretRight,
  Trash,
  Plus,
  X,
} from '@phosphor-icons/react';
import { PageHeader } from '../components/PageHeader';
import { api, getToken } from '../api/client';

// ============================================================================
// Types
// ============================================================================

type FormFieldType = 'text' | 'checkbox' | 'dropdown' | 'date' | 'signature';

interface DetectedField {
  id: string;
  label: string;
  type: FormFieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  options?: string[];
}

interface PdfPageImage {
  page: number;
  imageBase64: string;
  widthPx: number;
  heightPx: number;
}

interface PageDimension {
  width: number;
  height: number;
}

type Step = 'upload' | 'detecting' | 'editor' | 'generating' | 'done';

const FIELD_TYPES: { value: FormFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'date', label: 'Date' },
  { value: 'signature', label: 'Signature' },
];

const TYPE_COLORS: Record<string, string> = {
  text: 'border-blue-400 bg-blue-400/10',
  checkbox: 'border-green-400 bg-green-400/10',
  dropdown: 'border-purple-400 bg-purple-400/10',
  date: 'border-amber-400 bg-amber-400/10',
  signature: 'border-pink-400 bg-pink-400/10',
};

const TYPE_LABEL_COLORS: Record<string, string> = {
  text: 'bg-blue-400/80 text-blue-950',
  checkbox: 'bg-green-400/80 text-green-950',
  dropdown: 'bg-purple-400/80 text-purple-950',
  date: 'bg-amber-400/80 text-amber-950',
  signature: 'bg-pink-400/80 text-pink-950',
};

// ============================================================================
// Main Page
// ============================================================================

export function PdfToolsPage() {
  const [step, setStep] = useState<Step>('upload');
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pages, setPages] = useState<PdfPageImage[]>([]);
  const [pageDimensions, setPageDimensions] = useState<PageDimension[]>([]);
  const [fields, setFields] = useState<DetectedField[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const reset = useCallback(() => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setStep('upload');
    setPdfBase64(null);
    setFileName(null);
    setPages([]);
    setPageDimensions([]);
    setFields([]);
    setSelectedFieldId(null);
    setCurrentPage(0);
    setLoading(false);
    setError(null);
    setDownloadUrl(null);
  }, [downloadUrl]);

  const handleUpload = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);

      const result = await api<{ data: { pages: PdfPageImage[]; pageDimensions: PageDimension[] } }>(
        '/api/pdf-tools/convert',
        { method: 'POST', body: JSON.stringify({ pdfBase64: base64 }) },
      );

      setPdfBase64(base64);
      setFileName(file.name);
      setPages(result.data.pages);
      setPageDimensions(result.data.pageDimensions);
      setStep('detecting');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleDetect = useCallback(async (ollamaUrl: string, model: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<{ data: { fields: DetectedField[] } }>('/api/pdf-tools/detect', {
        method: 'POST',
        body: JSON.stringify({ pages, ollamaUrl, model }),
      });
      setFields(result.data.fields);
      setStep('editor');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Detection failed');
    } finally {
      setLoading(false);
    }
  }, [pages]);

  const handleGenerate = useCallback(async () => {
    if (!pdfBase64) return;
    setLoading(true);
    setError(null);
    setStep('generating');
    try {
      const token = getToken();
      const res = await fetch('/api/pdf-tools/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ originalPdfBase64: pdfBase64, fields, pageDimensions }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Generation failed' }));
        throw new Error(body.error || 'Generation failed');
      }

      const blob = await res.blob();
      setDownloadUrl(URL.createObjectURL(blob));
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
      setStep('editor');
    } finally {
      setLoading(false);
    }
  }, [pdfBase64, fields, pageDimensions]);

  const updateField = useCallback((id: string, updates: Partial<DetectedField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  }, []);

  const deleteField = useCallback((id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    setSelectedFieldId((prev) => (prev === id ? null : prev));
  }, []);

  const addField = useCallback((field: DetectedField) => {
    setFields((prev) => [...prev, field]);
    setSelectedFieldId(field.id);
  }, []);

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="PDF Tools" subtitle="Convert flat PDFs into fillable AcroForm documents" />

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      {step === 'upload' && <UploadSection onUpload={handleUpload} loading={loading} />}
      {step === 'detecting' && <DetectSection pages={pages} onDetect={handleDetect} loading={loading} />}
      {step === 'editor' && (
        <EditorSection
          pages={pages}
          fields={fields}
          currentPage={currentPage}
          selectedFieldId={selectedFieldId}
          onSetCurrentPage={setCurrentPage}
          onSelectField={setSelectedFieldId}
          onUpdateField={updateField}
          onDeleteField={deleteField}
          onAddField={addField}
          onGenerate={handleGenerate}
          onReset={reset}
        />
      )}
      {step === 'generating' && (
        <div className="flex flex-col items-center py-16 gap-4">
          <CircleNotch className="w-12 h-12 text-accent animate-spin" />
          <p className="text-neutral-400">Generating your fillable PDF...</p>
        </div>
      )}
      {step === 'done' && (
        <div className="flex flex-col items-center py-16 gap-6">
          <div className="w-20 h-20 rounded-full bg-green-500/10 flex items-center justify-center">
            <FilePdf className="w-10 h-10 text-green-400" />
          </div>
          <div className="text-center">
            <h2 className="text-xl font-bold">Your fillable PDF is ready</h2>
            <p className="text-neutral-400 text-sm mt-1">Open it in any PDF viewer to fill in the form fields.</p>
          </div>
          <div className="flex items-center gap-3">
            {downloadUrl && (
              <a
                href={downloadUrl}
                download={fileName?.replace(/\.pdf$/i, '-fillable.pdf') || 'form-fillable.pdf'}
                className="btn btn-primary flex items-center gap-2"
              >
                <DownloadSimple className="w-4 h-4" />
                Download PDF
              </a>
            )}
            <button onClick={reset} className="btn btn-secondary flex items-center gap-2">
              <ArrowClockwise className="w-4 h-4" />
              Convert Another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Upload
// ============================================================================

function UploadSection({ onUpload, loading }: { onUpload: (file: File) => void; loading: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div
      className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
        isDragging ? 'border-accent bg-accent/5' : 'border-white/[0.08] hover:border-muted'
      }`}
      onClick={() => fileInputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) onUpload(file);
      }}
    >
      <input ref={fileInputRef} type="file" accept=".pdf" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) onUpload(file);
      }} />
      {loading ? (
        <div className="flex flex-col items-center gap-3">
          <CircleNotch className="w-10 h-10 text-accent animate-spin" />
          <p className="text-neutral-400">Converting PDF pages to images...</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-full bg-white/[0.06] flex items-center justify-center">
            <UploadSimple className="w-8 h-8 text-neutral-400" />
          </div>
          <div>
            <p className="font-medium">Drop a PDF here or click to browse</p>
            <p className="text-neutral-400 text-sm mt-1">Max 20MB. The AI will detect fillable fields.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Detect
// ============================================================================

function DetectSection({
  pages,
  onDetect,
  loading,
}: {
  pages: PdfPageImage[];
  onDetect: (url: string, model: string) => void;
  loading: boolean;
}) {
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [model, setModel] = useState('llama3.2-vision');

  return (
    <div className="space-y-4">
      <div className="bg-white/[0.06] border border-white/[0.08] rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium">AI Field Detection</h3>
        <p className="text-xs text-neutral-400">
          {pages.length} {pages.length === 1 ? 'page' : 'pages'} ready. Configure your Ollama vision model, then detect fields.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-neutral-400 mb-1 block">Ollama URL</label>
            <input type="text" value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)}
              className="input w-full" disabled={loading} />
          </div>
          <div>
            <label className="text-xs text-neutral-400 mb-1 block">Vision Model</label>
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
              className="input w-full" disabled={loading} />
          </div>
        </div>
        <button onClick={() => onDetect(ollamaUrl, model)} disabled={loading}
          className="btn btn-primary">
          {loading ? (
            <span className="flex items-center gap-2">
              <CircleNotch className="w-4 h-4 animate-spin" />
              Detecting fields...
            </span>
          ) : 'Detect Fields'}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {pages.slice(0, 6).map((p) => (
          <div key={p.page} className="relative bg-white/[0.06] border border-white/[0.08] rounded-lg overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`data:image/png;base64,${p.imageBase64}`} alt={`Page ${p.page + 1}`} className="w-full" />
            <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-2 py-1 text-xs text-neutral-300">
              Page {p.page + 1}
            </div>
            {loading && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                <CircleNotch className="w-8 h-8 text-accent animate-spin" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Editor
// ============================================================================

function EditorSection({
  pages,
  fields,
  currentPage,
  selectedFieldId,
  onSetCurrentPage,
  onSelectField,
  onUpdateField,
  onDeleteField,
  onAddField,
  onGenerate,
  onReset,
}: {
  pages: PdfPageImage[];
  fields: DetectedField[];
  currentPage: number;
  selectedFieldId: string | null;
  onSetCurrentPage: (p: number) => void;
  onSelectField: (id: string | null) => void;
  onUpdateField: (id: string, u: Partial<DetectedField>) => void;
  onDeleteField: (id: string) => void;
  onAddField: (f: DetectedField) => void;
  onGenerate: () => void;
  onReset: () => void;
}) {
  const page = pages[currentPage];
  const pageFields = fields.filter((f) => f.page === currentPage);
  const selectedField = fields.find((f) => f.id === selectedFieldId);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (!containerRef.current) return;
      const target = e.target as HTMLElement;
      if (!target.classList.contains('pdf-page-img')) {
        return;
      }
      const rect = containerRef.current.getBoundingClientRect();
      const xPct = ((e.clientX - rect.left) / rect.width) * 100;
      const yPct = ((e.clientY - rect.top) / rect.height) * 100;
      onAddField({
        id: crypto.randomUUID(),
        label: `Field ${fields.length + 1}`,
        type: 'text',
        page: currentPage,
        x: Math.max(0, xPct - 10),
        y: Math.max(0, yPct - 1.5),
        width: 20,
        height: 3,
        required: false,
      });
    },
    [onAddField, currentPage, fields.length],
  );

  if (!page) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onReset} className="flex items-center gap-1 text-neutral-400 hover:text-white text-sm">
            <ArrowLeft className="w-4 h-4" /> Start Over
          </button>
          <span className="text-neutral-400">|</span>
          <span className="text-sm text-neutral-400">{fields.length} {fields.length === 1 ? 'field' : 'fields'} detected</span>
        </div>
        <button onClick={onGenerate} disabled={fields.length === 0} className="btn btn-primary flex items-center gap-2">
          <FilePdf className="w-4 h-4" /> Generate AcroForm PDF
        </button>
      </div>

      <div className="grid grid-cols-[1fr_280px] gap-4">
        <div className="space-y-3">
          <div ref={containerRef} className="relative bg-white/[0.06] rounded-lg overflow-hidden cursor-crosshair" onClick={handleCanvasClick}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`data:image/png;base64,${page.imageBase64}`} alt={`Page ${page.page + 1}`}
              className="pdf-page-img w-full block" draggable={false} />
            {pageFields.map((f) => (
              <FieldBox key={f.id} field={f} isSelected={f.id === selectedFieldId}
                containerRef={containerRef} onSelect={() => onSelectField(f.id)} onUpdate={onUpdateField} />
            ))}
          </div>
          {pages.length > 1 && (
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => onSetCurrentPage(Math.max(0, currentPage - 1))} disabled={currentPage === 0}
                className="p-1 rounded hover:bg-white/[0.06] disabled:opacity-30 text-neutral-400">
                <CaretLeft className="w-5 h-5" />
              </button>
              <span className="text-sm text-neutral-400">Page {currentPage + 1} of {pages.length}</span>
              <button onClick={() => onSetCurrentPage(Math.min(pages.length - 1, currentPage + 1))}
                disabled={currentPage === pages.length - 1} className="p-1 rounded hover:bg-white/[0.06] disabled:opacity-30 text-neutral-400">
                <CaretRight className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>

        <div className="bg-white/[0.06] border border-white/[0.08] rounded-lg overflow-y-auto max-h-[80vh] p-4">
          {selectedField ? (
            <FieldProperties field={selectedField} onUpdate={onUpdateField} onDelete={onDeleteField} onDeselect={() => onSelectField(null)} />
          ) : (
            <div className="text-center text-neutral-400 text-sm mt-8">
              <p>Click a field on the PDF to edit its properties.</p>
              <p className="mt-2 text-xs">Or click anywhere on the page to add a new field.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Field overlay (simplified, no dnd-kit for workspace)
// ============================================================================

function FieldBox({
  field,
  isSelected,
  containerRef,
  onSelect,
  onUpdate,
}: {
  field: DetectedField;
  isSelected: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onSelect: () => void;
  onUpdate: (id: string, u: Partial<DetectedField>) => void;
}) {
  const [_dragging, setDragging] = useState(false);
  const dragStart = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const colorClass = TYPE_COLORS[field.type] || TYPE_COLORS.text;
  const labelColor = TYPE_LABEL_COLORS[field.type] || TYPE_LABEL_COLORS.text;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    setDragging(true);
    dragStart.current = { startX: e.clientX, startY: e.clientY, origX: field.x, origY: field.y };

    const onMove = (me: MouseEvent) => {
      if (!dragStart.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dx = ((me.clientX - dragStart.current.startX) / rect.width) * 100;
      const dy = ((me.clientY - dragStart.current.startY) / rect.height) * 100;
      onUpdate(field.id, {
        x: Math.max(0, Math.min(100 - field.width, dragStart.current.origX + dx)),
        y: Math.max(0, Math.min(100 - field.height, dragStart.current.origY + dy)),
      });
    };

    const onUp = () => {
      setDragging(false);
      dragStart.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [field, containerRef, onSelect, onUpdate]);

  return (
    <div
      className={`absolute border-2 rounded ${colorClass} ${isSelected ? 'ring-2 ring-accent/50' : ''} cursor-grab`}
      style={{
        left: `${field.x}%`,
        top: `${field.y}%`,
        width: `${field.width}%`,
        height: `${field.height}%`,
        zIndex: isSelected ? 20 : 10,
      }}
      onMouseDown={handleMouseDown}
    >
      <div className={`absolute -top-5 left-0 px-1.5 py-0.5 rounded text-[9px] font-medium whitespace-nowrap ${labelColor}`}>
        {field.label}
      </div>
    </div>
  );
}

// ============================================================================
// Properties panel
// ============================================================================

function FieldProperties({
  field,
  onUpdate,
  onDelete,
  onDeselect,
}: {
  field: DetectedField;
  onUpdate: (id: string, u: Partial<DetectedField>) => void;
  onDelete: (id: string) => void;
  onDeselect: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Field Properties</h3>
        <button onClick={onDeselect} className="text-neutral-400 hover:text-white"><X className="w-4 h-4" /></button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-neutral-400 mb-1 block">Label</label>
          <input type="text" value={field.label} onChange={(e) => onUpdate(field.id, { label: e.target.value })}
            className="input w-full" />
        </div>
        <div>
          <label className="text-xs text-neutral-400 mb-1 block">Type</label>
          <select value={field.type} onChange={(e) => onUpdate(field.id, { type: e.target.value as FormFieldType })}
            className="input w-full">
            {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input type="checkbox" checked={field.required} onChange={(e) => onUpdate(field.id, { required: e.target.checked })} />
          Required field
        </label>
        {field.type === 'dropdown' && (
          <div>
            <label className="text-xs text-neutral-400 mb-1 block">Options</label>
            <div className="space-y-1.5">
              {(field.options || []).map((opt, i) => (
                <div key={i} className="flex items-center gap-1">
                  <input type="text" value={opt} onChange={(e) => {
                    const newOpts = [...(field.options || [])];
                    newOpts[i] = e.target.value;
                    onUpdate(field.id, { options: newOpts });
                  }} className="input flex-1 text-xs" />
                  <button onClick={() => onUpdate(field.id, { options: (field.options || []).filter((_, j) => j !== i) })}
                    className="text-neutral-400 hover:text-red-400"><X className="w-3 h-3" /></button>
                </div>
              ))}
              <button onClick={() => onUpdate(field.id, { options: [...(field.options || []), ''] })}
                className="flex items-center gap-1 text-xs text-accent hover:text-accent/80">
                <Plus className="w-3 h-3" /> Add option
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="pt-2 border-t border-white/[0.08]">
        <button onClick={() => onDelete(field.id)} className="flex items-center gap-2 text-red-400 hover:text-red-300 text-sm">
          <Trash className="w-4 h-4" /> Delete field
        </button>
      </div>
    </div>
  );
}
