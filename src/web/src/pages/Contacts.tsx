import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AddressBook, Plus, MagnifyingGlass } from '@phosphor-icons/react';
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
  created_at: string;
}

const TYPES = ['all', 'lead', 'client', 'partner', 'vendor'] as const;

export function ContactsPage() {
  const wsTick = useWsRefresh(['contact:upserted', 'contact:removed']);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);

  const { data: contacts, loading, refetch } = useApi<Contact[]>('/api/contacts', [wsTick]);

  const filtered = useMemo(() => {
    if (!contacts) return [];
    let result = contacts;
    if (filter !== 'all') {
      result = result.filter(c => c.contact_type === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.company || '').toLowerCase().includes(q)
      );
    }
    return result;
  }, [contacts, filter, search]);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Contacts"
        subtitle="People and companies your agents interact with"
        action={
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            <Plus size={14} /> New contact
          </button>
        }
      />

      {showForm && (
        <NewContactForm onClose={() => setShowForm(false)} onSuccess={refetch} />
      )}

      {/* Type filter */}
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {TYPES.map(t => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`px-3 py-1 rounded text-xs capitalize transition-colors ${
              filter === t ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, email, or company..."
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
        />
      </div>

      {loading ? (
        <RowSkeleton count={5} />
      ) : !filtered.length ? (
        <EmptyState
          icon={<AddressBook size={32} />}
          title="No contacts yet"
          description={search ? `No contacts matching "${search}".` : 'Add your first contact to get started.'}
        />
      ) : (
        <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
          {filtered.map(contact => (
            <Link key={contact.id} to={`/contacts/${contact.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors">
              <div className="min-w-0 mr-3">
                <p className="text-sm font-medium truncate">{contact.name}</p>
                <p className="text-xs text-neutral-400">
                  {contact.email && <span>{contact.email}</span>}
                  {contact.email && contact.company && ' · '}
                  {contact.company && <span className="text-white">{contact.company}</span>}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-neutral-400 capitalize">{contact.contact_type}</span>
                <StatusBadge status={contact.status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function NewContactForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [contactType, setContactType] = useState('lead');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await api('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || undefined,
          company: company.trim() || undefined,
          contact_type: contactType,
        }),
      });
      onSuccess();
      onClose();
    } catch {
      // handled by toast
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border border-white/[0.08] rounded-lg p-4 mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Contact name"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Email</label>
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="email@example.com"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Company</label>
          <input
            value={company}
            onChange={e => setCompany(e.target.value)}
            placeholder="Company name"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
          />
        </div>
        <div>
          <label className="text-xs text-neutral-400 block mb-1">Type</label>
          <select
            value={contactType}
            onChange={e => setContactType(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-white/20"
          >
            <option value="lead">Lead</option>
            <option value="client">Client</option>
            <option value="partner">Partner</option>
            <option value="vendor">Vendor</option>
          </select>
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors">Cancel</button>
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="px-3 py-1.5 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Creating...' : 'Create contact'}
        </button>
      </div>
    </form>
  );
}
