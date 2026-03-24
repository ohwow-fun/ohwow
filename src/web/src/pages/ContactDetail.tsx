import { useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Trash, AddressBook } from '@phosphor-icons/react';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/StatusBadge';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { RowSkeleton } from '../components/Skeleton';
import { api } from '../api/client';

interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  contact_type: string;
  status: string;
  tags: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface TimelineEvent {
  id: string;
  event_type: string;
  description: string | null;
  metadata: string | null;
  created_at: string;
}

export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const wsTick = useWsRefresh(['contact:upserted']);
  const { data: contact, loading, refetch } = useApi<Contact>(id ? `/api/contacts/${id}` : null, [wsTick]);
  const { data: timeline } = useApi<TimelineEvent[]>(id ? `/api/contacts/${id}/timeline` : null, [wsTick]);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const startEdit = useCallback(() => {
    if (!contact) return;
    setEditName(contact.name);
    setEditEmail(contact.email || '');
    setEditPhone(contact.phone || '');
    setEditCompany(contact.company || '');
    setEditNotes(contact.notes || '');
    setEditing(true);
  }, [contact]);

  const saveEdit = useCallback(async () => {
    if (!id || !editName.trim()) return;
    setSaving(true);
    try {
      await api(`/api/contacts/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editName.trim(),
          email: editEmail.trim() || null,
          phone: editPhone.trim() || null,
          company: editCompany.trim() || null,
          notes: editNotes.trim() || null,
        }),
      });
      setEditing(false);
      refetch();
    } catch {
      // handled by toast
    } finally {
      setSaving(false);
    }
  }, [id, editName, editEmail, editPhone, editCompany, editNotes, refetch]);

  const handleDelete = useCallback(async () => {
    if (!id || !confirm('Delete this contact? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await api(`/api/contacts/${id}`, { method: 'DELETE' });
      navigate('/contacts');
    } catch {
      setDeleting(false);
    }
  }, [id, navigate]);

  if (loading) return <div className="p-6"><RowSkeleton count={4} /></div>;
  if (!contact) return <div className="p-6 text-neutral-400">Contact not found</div>;

  return (
    <div className="p-6 max-w-4xl">
      <Link to="/contacts" className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-white mb-4">
        <ArrowLeft size={14} /> Back to contacts
      </Link>

      <PageHeader
        title={contact.name}
        subtitle={`${contact.contact_type} · Added ${new Date(contact.created_at).toLocaleDateString()}`}
        action={
          <div className="flex items-center gap-2">
            {!editing && (
              <button
                onClick={startEdit}
                className="px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 text-white rounded-lg hover:bg-white/10 transition-colors"
              >
                Edit
              </button>
            )}
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-critical/10 border border-critical/30 text-critical rounded-lg hover:bg-critical/20 disabled:opacity-50 transition-colors"
            >
              <Trash size={14} /> {deleting ? 'Deleting...' : 'Delete'}
            </button>
            <StatusBadge status={contact.status} />
          </div>
        }
      />

      {/* Contact Info */}
      {editing ? (
        <div className="border border-white/[0.08] rounded-lg p-4 mb-6 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-neutral-400 block mb-1">Name</label>
              <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20" />
            </div>
            <div>
              <label className="text-xs text-neutral-400 block mb-1">Email</label>
              <input value={editEmail} onChange={e => setEditEmail(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-neutral-400 block mb-1">Phone</label>
              <input value={editPhone} onChange={e => setEditPhone(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20" />
            </div>
            <div>
              <label className="text-xs text-neutral-400 block mb-1">Company</label>
              <input value={editCompany} onChange={e => setEditCompany(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20" />
            </div>
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Notes</label>
            <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} rows={3} className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white resize-none focus:outline-none focus:border-white/20" />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">Cancel</button>
            <button onClick={saveEdit} disabled={saving || !editName.trim()} className="px-3 py-1.5 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08] mb-6">
          {[
            { label: 'Email', value: contact.email },
            { label: 'Phone', value: contact.phone },
            { label: 'Company', value: contact.company },
            { label: 'Notes', value: contact.notes },
          ].map(row => row.value ? (
            <div key={row.label} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-neutral-400">{row.label}</span>
              <span className="text-sm font-medium">{row.value}</span>
            </div>
          ) : null)}
        </div>
      )}

      {/* Timeline */}
      <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Timeline</h2>
      {!timeline?.length ? (
        <EmptyState
          icon={<AddressBook size={32} />}
          title="No activity yet"
          description="Events will appear here as agents interact with this contact."
        />
      ) : (
        <div className="space-y-2">
          {timeline.map(event => (
            <div key={event.id} className="border border-white/[0.08] rounded-lg px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-white font-medium">{event.event_type.replace(/_/g, ' ')}</span>
                <span className="text-xs text-neutral-400">{new Date(event.created_at).toLocaleString()}</span>
              </div>
              {event.description && <p className="text-sm">{event.description}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
