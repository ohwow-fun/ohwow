import { useState, useRef, useEffect, useMemo } from 'react';
import { ChatCircleDots, Power, QrCode, CircleNotch, X, CaretDown, UserCircle, Users, PencilSimple } from '@phosphor-icons/react';
import { motion, AnimatePresence } from 'framer-motion';
import QRCode from 'qrcode';
import { useApi } from '../hooks/useApi';
import { useWsListener } from '../hooks/useWebSocket';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { RowSkeleton } from '../components/Skeleton';
import { FeatureIntro } from '../components/FeatureIntro';
import { api } from '../api/client';
import { toast } from '../components/Toast';

// ─── Country codes ────────────────────────────────────────────────────────────

const COUNTRY_CODES = [
  { code: '1',   flag: '🇺🇸', name: 'US' },
  { code: '1',   flag: '🇨🇦', name: 'CA' },
  { code: '44',  flag: '🇬🇧', name: 'GB' },
  { code: '57',  flag: '🇨🇴', name: 'CO' },
  { code: '52',  flag: '🇲🇽', name: 'MX' },
  { code: '54',  flag: '🇦🇷', name: 'AR' },
  { code: '55',  flag: '🇧🇷', name: 'BR' },
  { code: '56',  flag: '🇨🇱', name: 'CL' },
  { code: '51',  flag: '🇵🇪', name: 'PE' },
  { code: '58',  flag: '🇻🇪', name: 'VE' },
  { code: '34',  flag: '🇪🇸', name: 'ES' },
  { code: '33',  flag: '🇫🇷', name: 'FR' },
  { code: '49',  flag: '🇩🇪', name: 'DE' },
  { code: '39',  flag: '🇮🇹', name: 'IT' },
  { code: '31',  flag: '🇳🇱', name: 'NL' },
  { code: '351', flag: '🇵🇹', name: 'PT' },
  { code: '91',  flag: '🇮🇳', name: 'IN' },
  { code: '86',  flag: '🇨🇳', name: 'CN' },
  { code: '81',  flag: '🇯🇵', name: 'JP' },
  { code: '82',  flag: '🇰🇷', name: 'KR' },
  { code: '61',  flag: '🇦🇺', name: 'AU' },
  { code: '64',  flag: '🇳🇿', name: 'NZ' },
  { code: '27',  flag: '🇿🇦', name: 'ZA' },
  { code: '234', flag: '🇳🇬', name: 'NG' },
  { code: '20',  flag: '🇪🇬', name: 'EG' },
  { code: '971', flag: '🇦🇪', name: 'AE' },
  { code: '966', flag: '🇸🇦', name: 'SA' },
  { code: '972', flag: '🇮🇱', name: 'IL' },
  { code: '7',   flag: '🇷🇺', name: 'RU' },
  { code: '380', flag: '🇺🇦', name: 'UA' },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhatsAppConnection {
  connectionId: string | null;
  phoneNumber: string | null;
  label: string | null;
  isDefault: boolean;
  status: string;
}

interface AllowedChat {
  id: string;
  chat_id: string;
  chat_name: string | null;
  chat_type: string;
  contact_id: string | null;
  team_member_id: string | null;
}

interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  contact_type: string;
}

interface TeamMember {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
}

type PersonKind = 'contact' | 'teammate';
interface Person { id: string; name: string; subtitle: string; kind: PersonKind }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatPhone(raw: string | null): string {
  if (!raw) return 'WhatsApp';
  return raw.startsWith('+') ? raw : `+${raw}`;
}

function connStatusText(status: string): string {
  if (status === 'connected') return 'Connected';
  if (status === 'qr_pending') return 'Waiting for scan';
  return 'Disconnected';
}

function connBadgeStatus(status: string): string {
  if (status === 'connected') return 'active';
  if (status === 'qr_pending') return 'pending';
  return 'disconnected';
}

// ─── PersonPicker ─────────────────────────────────────────────────────────────

interface PersonPickerProps {
  people: Person[];
  value: { contactId: string | null; teamMemberId: string | null };
  onChange: (v: { contactId: string | null; teamMemberId: string | null }) => void;
  placeholder?: string;
}

function PersonPicker({ people, value, onChange, placeholder = 'Link to contact or teammate…' }: PersonPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selected = people.find(p =>
    (p.kind === 'contact' && p.id === value.contactId) ||
    (p.kind === 'teammate' && p.id === value.teamMemberId),
  );

  const filtered = useMemo(() =>
    search
      ? people.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || p.subtitle.toLowerCase().includes(search.toLowerCase()))
      : people,
  [people, search]);

  useEffect(() => {
    if (!open) { setSearch(''); return; }
    function outside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  function select(p: Person) {
    onChange(p.kind === 'contact' ? { contactId: p.id, teamMemberId: null } : { contactId: null, teamMemberId: p.id });
    setOpen(false);
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange({ contactId: null, teamMemberId: null });
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-white/5 border border-white/10 rounded text-sm hover:border-white/20 transition-colors text-left"
      >
        {selected ? (
          <>
            {selected.kind === 'contact'
              ? <UserCircle size={14} className="text-blue-400 shrink-0" />
              : <Users size={14} className="text-purple-400 shrink-0" />}
            <span className="text-white truncate">{selected.name}</span>
            <span className="ml-auto text-[10px] text-neutral-500 shrink-0">{selected.kind === 'contact' ? 'CRM' : 'Team'}</span>
            <button onClick={clear} className="text-neutral-500 hover:text-white shrink-0 ml-1">
              <X size={12} />
            </button>
          </>
        ) : (
          <>
            <UserCircle size={14} className="text-neutral-500 shrink-0" />
            <span className="text-neutral-500 truncate">{placeholder}</span>
            <CaretDown size={10} className="text-neutral-600 ml-auto shrink-0" />
          </>
        )}
      </button>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-neutral-900 border border-white/10 rounded-lg shadow-xl overflow-hidden">
          <div className="p-2 border-b border-white/[0.06]">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full bg-white/5 rounded px-2 py-1 text-xs text-white placeholder:text-neutral-500 focus:outline-none"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="px-3 py-3 text-xs text-neutral-500">No contacts or teammates found</p>
            )}
            {filtered.map(p => (
              <button
                key={`${p.kind}-${p.id}`}
                type="button"
                onClick={() => select(p)}
                className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-neutral-300 hover:bg-white/5 transition-colors text-left"
              >
                {p.kind === 'contact'
                  ? <UserCircle size={14} className="text-blue-400 shrink-0" />
                  : <Users size={14} className="text-purple-400 shrink-0" />}
                <span className="truncate">{p.name}</span>
                {p.subtitle && <span className="ml-auto text-xs text-neutral-500 truncate max-w-[120px]">{p.subtitle}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PhoneInput ───────────────────────────────────────────────────────────────

interface PhoneInputProps {
  countryCode: string;
  phone: string;
  onCountryChange: (code: string) => void;
  onPhoneChange: (val: string) => void;
  linkValue: { contactId: string | null; teamMemberId: string | null };
  onLinkChange: (v: { contactId: string | null; teamMemberId: string | null }) => void;
  people: Person[];
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
}

function PhoneInput({ countryCode, phone, onCountryChange, onPhoneChange, linkValue, onLinkChange, people, onSubmit, onCancel, submitting }: PhoneInputProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selected = COUNTRY_CODES.find(c => c.code === countryCode) ?? COUNTRY_CODES[0];

  const filtered = search
    ? COUNTRY_CODES.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || c.code.includes(search))
    : COUNTRY_CODES;

  useEffect(() => {
    if (!open) { setSearch(''); return; }
    function onClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div className="flex gap-2">
      {/* Country code picker */}
      <div ref={dropdownRef} className="relative">
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="flex items-center gap-1.5 h-full px-3 bg-white/5 border border-white/10 rounded text-sm text-white hover:border-white/20 transition-colors whitespace-nowrap"
          >
            <span>{selected.flag}</span>
            <span className="text-neutral-400">+{selected.code}</span>
            <CaretDown size={10} className="text-neutral-500" />
          </button>
          {open && (
            <div className="absolute z-50 top-full mt-1 left-0 w-52 bg-neutral-900 border border-white/10 rounded-lg shadow-xl overflow-hidden">
              <div className="p-2 border-b border-white/[0.06]">
                <input
                  autoFocus
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="w-full bg-white/5 rounded px-2 py-1 text-xs text-white placeholder:text-neutral-500 focus:outline-none"
                />
              </div>
              <div className="max-h-48 overflow-y-auto">
                {filtered.map(c => (
                  <button
                    key={`${c.name}-${c.code}`}
                    type="button"
                    onClick={() => { onCountryChange(c.code); setOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-neutral-300 hover:bg-white/5 transition-colors text-left"
                  >
                    <span>{c.flag}</span>
                    <span className="font-medium">{c.name}</span>
                    <span className="ml-auto text-neutral-500">+{c.code}</span>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="px-3 py-3 text-xs text-neutral-500">No results</p>
                )}
              </div>
            </div>
          )}
        </div>

      <input
        type="tel"
        value={phone}
        onChange={e => onPhoneChange(e.target.value.replace(/\D/g, ''))}
        onKeyDown={e => e.key === 'Enter' && onSubmit()}
        placeholder="Phone number"
        className="w-36 bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
      />

      {people.length > 0 && (
        <div className="flex-1 min-w-0">
          <PersonPicker
            people={people}
            value={linkValue}
            onChange={onLinkChange}
          />
        </div>
      )}

      <button
        onClick={onSubmit}
        disabled={submitting || !phone.trim()}
        className="px-3 py-2 text-xs font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
      >
        {submitting ? 'Adding…' : 'Add'}
      </button>
      <button
        onClick={onCancel}
        className="text-neutral-500 hover:text-white transition-colors px-2"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function MessagingPage() {
  const { data, loading, refetch } = useApi<{ connections: WhatsAppConnection[] }>('/api/whatsapp/connections');
  const connections = data?.connections;
  const { data: statusData, refetch: refetchStatus } = useApi<{ allowedChats: AllowedChat[] }>('/api/whatsapp/status');
  const allowedChats = statusData?.allowedChats ?? [];

  const { data: contactsData } = useApi<Contact[]>('/api/contacts');
  const { data: teamData } = useApi<TeamMember[]>('/api/team-members');

  const people: Person[] = useMemo(() => [
    ...(Array.isArray(contactsData) ? contactsData : []).map(c => ({
      id: c.id, name: c.name, subtitle: c.email ?? c.phone ?? '', kind: 'contact' as PersonKind,
    })),
    ...(Array.isArray(teamData) ? teamData : []).map(m => ({
      id: m.id, name: m.name, subtitle: m.role ?? m.email ?? '', kind: 'teammate' as PersonKind,
    })),
  ], [contactsData, teamData]);

  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [addPhone, setAddPhone] = useState('');
  const [addCountry, setAddCountry] = useState('1');
  const [addLink, setAddLink] = useState<{ contactId: string | null; teamMemberId: string | null }>({ contactId: null, teamMemberId: null });
  const [addingChat, setAddingChat] = useState(false);
  const [editingLinkFor, setEditingLinkFor] = useState<string | null>(null); // chat_id being edited
  const [linkingChat, setLinkingChat] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [waitingForQr, setWaitingForQr] = useState(false);
  const qrTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const realConnections = connections?.filter(c => c.connectionId) ?? [];
  const isEmpty = !loading && realConnections.length === 0;
  const activeConn = realConnections.find(c => c.status === 'connected' || c.status === 'active');

  useEffect(() => {
    if (!activeConn?.phoneNumber) return;
    const digits = activeConn.phoneNumber.replace(/\D/g, '');
    const match = COUNTRY_CODES
      .slice()
      .sort((a, b) => b.code.length - a.code.length)
      .find(c => digits.startsWith(c.code));
    if (match) setAddCountry(match.code);
  }, [activeConn?.phoneNumber]);

  useEffect(() => {
    if (activeConn) {
      setQrDataUrl(null);
      setWaitingForQr(false);
      if (qrTimeoutRef.current) clearTimeout(qrTimeoutRef.current);
    }
  }, [activeConn]);

  useWsListener((event, data) => {
    if (event === 'whatsapp:qr') {
      const { qr } = data as { qr: string };
      QRCode.toDataURL(qr, { width: 256, margin: 2 }).then(url => {
        setQrDataUrl(url);
        setWaitingForQr(false);
        if (qrTimeoutRef.current) clearTimeout(qrTimeoutRef.current);
        qrTimeoutRef.current = setTimeout(() => setQrDataUrl(null), 60_000);
      }).catch(() => {});
    } else if (event === 'whatsapp:connected') {
      setQrDataUrl(null);
      setWaitingForQr(false);
      if (qrTimeoutRef.current) clearTimeout(qrTimeoutRef.current);
      refetch();
    } else if (event === 'whatsapp:disconnected') {
      refetch();
    }
  });

  const handleConnect = async () => {
    setConnecting(true);
    setWaitingForQr(true);
    setQrDataUrl(null);
    try {
      await api('/api/whatsapp/connect', { method: 'POST' });
      refetch();
    } catch {
      toast('error', 'Couldn\'t start WhatsApp connection');
      setWaitingForQr(false);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api('/api/whatsapp/disconnect', { method: 'POST' });
      toast('success', 'WhatsApp disconnected');
      refetch();
    } catch {
      toast('error', 'Couldn\'t disconnect WhatsApp');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleAddChat = async () => {
    if (!addPhone.trim()) return;
    const chatId = `${addCountry}${addPhone.trim()}@c.us`;
    setAddingChat(true);
    try {
      await api('/api/whatsapp/chats', {
        method: 'POST',
        body: JSON.stringify({ chatId, contactId: addLink.contactId, teamMemberId: addLink.teamMemberId }),
      });
      toast('success', 'Chat added');
      setAddPhone('');
      setAddLink({ contactId: null, teamMemberId: null });
      refetch();
      refetchStatus();
    } catch {
      toast('error', 'Couldn\'t add chat');
    } finally {
      setAddingChat(false);
    }
  };

  const handleRemoveChat = async (chatId: string) => {
    try {
      await api('/api/whatsapp/chats', {
        method: 'DELETE',
        body: JSON.stringify({ chatId }),
      });
      toast('success', 'Chat removed');
      refetch();
      refetchStatus();
    } catch {
      toast('error', 'Couldn\'t remove chat');
    }
  };

  const handleSaveLink = async (chatId: string, contactId: string | null, teamMemberId: string | null) => {
    setLinkingChat(true);
    try {
      await api('/api/whatsapp/chats', {
        method: 'PATCH',
        body: JSON.stringify({ chatId, contactId, teamMemberId }),
      });
      toast('success', 'Link saved');
      setEditingLinkFor(null);
      refetchStatus();
    } catch {
      toast('error', 'Couldn\'t save link');
    } finally {
      setLinkingChat(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Messaging"
        subtitle="WhatsApp and messaging channel connections"
        action={
          activeConn ? (
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-critical/10 border border-critical/30 text-critical rounded-md hover:bg-critical/20 disabled:opacity-50 transition-colors"
            >
              {disconnecting ? <CircleNotch size={14} className="animate-spin" /> : <Power size={14} />}
              Disconnect
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={connecting || waitingForQr}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
            >
              {connecting || waitingForQr ? <CircleNotch size={14} className="animate-spin" /> : <QrCode size={14} />}
              Connect WhatsApp
            </button>
          )
        }
      />

      <AnimatePresence>
        {(waitingForQr || qrDataUrl) && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mb-6 border border-white/[0.08] rounded-lg p-6 flex flex-col items-center gap-4"
          >
            {qrDataUrl ? (
              <>
                <p className="text-sm font-medium">Scan with WhatsApp</p>
                <img src={qrDataUrl} alt="WhatsApp QR code" className="rounded-lg w-48 h-48" />
                <p className="text-xs text-neutral-500">Open WhatsApp → Settings → Linked Devices → Link a Device</p>
              </>
            ) : (
              <>
                <CircleNotch size={32} className="animate-spin text-neutral-400" />
                <p className="text-sm text-neutral-400">Generating QR code…</p>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <RowSkeleton count={3} />
      ) : isEmpty ? (
        <FeatureIntro
          icon={ChatCircleDots}
          title="No messaging channels connected"
          description="Connect WhatsApp to let your agents communicate through messaging apps."
          capabilities={[
            { icon: QrCode, label: 'QR pairing', description: 'Scan to connect' },
            { icon: ChatCircleDots, label: 'Chat filtering', description: 'Control which chats agents can access' },
            { icon: Power, label: 'Easy management', description: 'Connect and disconnect anytime' },
          ]}
          action={{ label: 'Connect WhatsApp', onClick: handleConnect }}
        />
      ) : (
        <div className="space-y-6">
          <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
            {realConnections.map((conn, i) => (
              <div key={conn.connectionId ?? i} className="flex items-center justify-between px-4 py-4">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${conn.status === 'connected' ? 'bg-green-500/10' : 'bg-white/5'}`}>
                    <ChatCircleDots size={20} className={conn.status === 'connected' ? 'text-green-400' : 'text-neutral-500'} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {formatPhone(conn.phoneNumber) || conn.label || 'WhatsApp'}
                    </p>
                    <p className="text-xs text-neutral-500">{connStatusText(conn.status)}</p>
                  </div>
                </div>
                <StatusBadge status={connBadgeStatus(conn.status)} />
              </div>
            ))}
          </div>

          <div>
            <h3 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-3">Allowed chats</h3>

            {allowedChats.length > 0 && (
              <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08] mb-3">
                {allowedChats.map(chat => {
                  const linked = people.find(p =>
                    (p.kind === 'contact' && p.id === chat.contact_id) ||
                    (p.kind === 'teammate' && p.id === chat.team_member_id),
                  );
                  const isEditing = editingLinkFor === chat.chat_id;

                  return (
                    <div key={chat.id} className="px-4 py-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">{chat.chat_name || formatPhone(chat.chat_id.replace('@c.us', '').replace('@g.us', ''))}</p>
                          <p className="text-xs text-neutral-500">{chat.chat_id}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {linked && !isEditing && (
                            <span className="flex items-center gap-1 text-xs text-neutral-400">
                              {linked.kind === 'contact'
                                ? <UserCircle size={12} className="text-blue-400" />
                                : <Users size={12} className="text-purple-400" />}
                              {linked.name}
                            </span>
                          )}
                          {people.length > 0 && (
                            <button
                              onClick={() => setEditingLinkFor(isEditing ? null : chat.chat_id)}
                              className="text-neutral-500 hover:text-white transition-colors p-1"
                              title={linked ? 'Edit link' : 'Link to contact or teammate'}
                            >
                              <PencilSimple size={13} />
                            </button>
                          )}
                          <button
                            onClick={() => handleRemoveChat(chat.chat_id)}
                            className="text-neutral-500 hover:text-critical transition-colors p-1"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>

                      <AnimatePresence>
                        {isEditing && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden"
                          >
                            <InlineLinkEditor
                              chat={chat}
                              people={people}
                              onSave={(contactId, teamMemberId) => handleSaveLink(chat.chat_id, contactId, teamMemberId)}
                              onCancel={() => setEditingLinkFor(null)}
                              saving={linkingChat}
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mb-3">
              <PhoneInput
                countryCode={addCountry}
                phone={addPhone}
                onCountryChange={setAddCountry}
                onPhoneChange={setAddPhone}
                linkValue={addLink}
                onLinkChange={setAddLink}
                people={people}
                onSubmit={handleAddChat}
                onCancel={() => { setAddPhone(''); setAddLink({ contactId: null, teamMemberId: null }); }}
                submitting={addingChat}
              />
            </div>

            <p className="text-xs text-neutral-500">
              Agents only respond to allowed numbers. Leave empty to allow all chats.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── InlineLinkEditor ─────────────────────────────────────────────────────────

interface InlineLinkEditorProps {
  chat: AllowedChat;
  people: Person[];
  onSave: (contactId: string | null, teamMemberId: string | null) => void;
  onCancel: () => void;
  saving: boolean;
}

function InlineLinkEditor({ chat, people, onSave, onCancel, saving }: InlineLinkEditorProps) {
  const [value, setValue] = useState<{ contactId: string | null; teamMemberId: string | null }>({
    contactId: chat.contact_id,
    teamMemberId: chat.team_member_id,
  });

  return (
    <div className="flex gap-2 mt-2 pt-2 border-t border-white/[0.06]">
      <div className="flex-1">
        <PersonPicker people={people} value={value} onChange={setValue} />
      </div>
      <button
        onClick={() => onSave(value.contactId, value.teamMemberId)}
        disabled={saving}
        className="px-3 py-2 text-xs font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors whitespace-nowrap"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button onClick={onCancel} className="text-neutral-500 hover:text-white transition-colors px-2">
        <X size={14} />
      </button>
    </div>
  );
}
