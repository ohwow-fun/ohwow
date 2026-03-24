import { useState, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';
import { api, getToken } from '../api/client';
import {
  BookOpen,
  FileText,
  Globe,
  Trash,
  Upload,
  MagnifyingGlass,
} from '@phosphor-icons/react';

interface KnowledgeDoc {
  id: string;
  title: string;
  type: 'file' | 'url';
  status: string;
  created_at: string;
  chunk_count?: number;
}

export function KnowledgePage() {
  const { data: docs, loading, refetch } = useApi<KnowledgeDoc[]>('/api/knowledge');
  const [search, setSearch] = useState('');
  const [showUpload, setShowUpload] = useState(false);

  const filtered = docs?.filter(d =>
    d.title.toLowerCase().includes(search.toLowerCase())
  );

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api(`/api/knowledge/${id}`, { method: 'DELETE' });
      toast('success', 'Document removed');
      refetch();
    } catch {
      toast('error', 'Couldn\'t remove document');
    }
  }, [refetch]);

  return (
    <div className="p-6 max-w-5xl">
      <PageHeader
        title="Knowledge"
        subtitle="Documents and context for your agents"
        action={
          <button
            onClick={() => setShowUpload(true)}
            className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            Add document
          </button>
        }
      />

      <div className="mb-4">
        <div className="relative">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            placeholder="Search documents..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 bg-white/5 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : filtered?.length ? (
        <div className="space-y-2">
          {filtered.map(doc => (
            <div
              key={doc.id}
              className="flex items-center gap-4 px-4 py-3 border border-white/[0.08] rounded-lg hover:bg-white/[0.02] transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-neutral-400">
                {doc.type === 'url' ? <Globe size={16} /> : <FileText size={16} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{doc.title}</p>
                <p className="text-xs text-neutral-500">
                  {doc.chunk_count != null ? `${doc.chunk_count} chunks` : doc.type}
                  {' \u00b7 '}
                  {new Date(doc.created_at).toLocaleDateString()}
                </p>
              </div>
              <StatusBadge status={doc.status} />
              <button
                onClick={() => handleDelete(doc.id)}
                className="text-neutral-500 hover:text-critical transition-colors"
              >
                <Trash size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<BookOpen size={32} />}
          title="Nothing here yet"
          description="Upload documents or add URLs to give your agents more context."
          action={
            <button
              onClick={() => setShowUpload(true)}
              className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
            >
              Add your first document
            </button>
          }
        />
      )}

      <UploadModal open={showUpload} onClose={() => setShowUpload(false)} onSuccess={() => { setShowUpload(false); refetch(); }} />
    </div>
  );
}

function UploadModal({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [url, setUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleFileUpload = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach(f => formData.append('files', f));
      const token = getToken();
      await fetch('/api/knowledge/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      toast('success', `Uploaded ${files.length === 1 ? '1 document' : `${files.length} documents`}`);
      onSuccess();
    } catch {
      toast('error', 'Couldn\'t upload. Try again?');
    } finally {
      setUploading(false);
    }
  }, [onSuccess]);

  const handleUrlImport = useCallback(async () => {
    if (!url.trim()) return;
    setUploading(true);
    try {
      await api('/api/knowledge/url', { method: 'POST', body: JSON.stringify({ url: url.trim() }) });
      toast('success', 'URL imported');
      onSuccess();
    } catch {
      toast('error', 'Couldn\'t import URL. Try again?');
    } finally {
      setUploading(false);
    }
  }, [url, onSuccess]);

  return (
    <Modal open={open} onClose={onClose} title="Add document">
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setMode('file')}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${mode === 'file' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'}`}
        >
          Upload file
        </button>
        <button
          onClick={() => setMode('url')}
          className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${mode === 'url' ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'}`}
        >
          Import URL
        </button>
      </div>

      {mode === 'file' ? (
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); handleFileUpload(e.dataTransfer.files); }}
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            dragOver ? 'border-white/30 bg-white/5' : 'border-white/10'
          }`}
        >
          <Upload size={24} className="mx-auto text-neutral-500 mb-2" />
          <p className="text-sm text-neutral-400 mb-2">Drag and drop files here</p>
          <label className="inline-block px-4 py-2 text-xs font-medium bg-white/10 text-white rounded cursor-pointer hover:bg-white/15 transition-colors">
            Choose files
            <input type="file" multiple className="hidden" onChange={e => handleFileUpload(e.target.files)} />
          </label>
        </div>
      ) : (
        <div className="space-y-3">
          <input
            type="url"
            placeholder="https://..."
            value={url}
            onChange={e => setUrl(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
          <button
            onClick={handleUrlImport}
            disabled={!url.trim() || uploading}
            className="w-full px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors disabled:opacity-50"
          >
            {uploading ? 'Importing...' : 'Import'}
          </button>
        </div>
      )}

      {uploading && mode === 'file' && (
        <p className="text-xs text-neutral-400 mt-3 text-center">Uploading...</p>
      )}
    </Modal>
  );
}
