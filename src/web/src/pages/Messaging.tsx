import { useState } from 'react';
import { ChatCircleDots, Plus, Trash, Power, QrCode, CircleNotch, X } from '@phosphor-icons/react';
import { motion, AnimatePresence } from 'framer-motion';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { RowSkeleton } from '../components/Skeleton';
import { FeatureIntro } from '../components/FeatureIntro';
import { api } from '../api/client';
import { toast } from '../components/Toast';

interface WhatsAppConnection {
  connectionId: string | null;
  phoneNumber: string | null;
  label: string | null;
  isDefault: boolean;
  status: string;
}

export function MessagingPage() {
  const { data, loading, refetch } = useApi<{ connections: WhatsAppConnection[] }>('/api/whatsapp/connections');
  const connections = data?.connections;
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [newChatId, setNewChatId] = useState('');
  const [addingChat, setAddingChat] = useState(false);
  const [showAddChat, setShowAddChat] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await api('/api/whatsapp/connect', { method: 'POST' });
      toast('success', 'Connecting to WhatsApp. Check for QR code.');
      refetch();
    } catch {
      toast('error', 'Couldn\'t start WhatsApp connection');
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
    if (!newChatId.trim()) return;
    setAddingChat(true);
    try {
      await api('/api/whatsapp/chats', {
        method: 'POST',
        body: JSON.stringify({ chatId: newChatId.trim() }),
      });
      toast('success', 'Chat added to allowed list');
      setNewChatId('');
      setShowAddChat(false);
      refetch();
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
    } catch {
      toast('error', 'Couldn\'t remove chat');
    }
  };

  const realConnections = connections?.filter(c => c.connectionId) ?? [];
  const isEmpty = !loading && realConnections.length === 0;
  const activeConn = realConnections.find(c => c.status === 'connected' || c.status === 'active');

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
              disabled={connecting}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
            >
              {connecting ? <CircleNotch size={14} className="animate-spin" /> : <QrCode size={14} />}
              Connect WhatsApp
            </button>
          )
        }
      />

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
          {/* Connection cards */}
          <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
            {realConnections.map((conn, i) => (
              <div key={conn.connectionId ?? i} className="flex items-center justify-between px-4 py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
                    <ChatCircleDots size={20} className="text-green-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {conn.phoneNumber || conn.label || 'WhatsApp'}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {conn.status === 'connected' ? 'Connected' : 'No activity yet'}
                    </p>
                  </div>
                </div>
                <StatusBadge status={conn.status === 'connected' ? 'active' : conn.status} />
              </div>
            ))}
          </div>

          {/* Allowed chats section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Allowed chats</h3>
              <button
                onClick={() => setShowAddChat(!showAddChat)}
                className="flex items-center gap-1 text-xs text-neutral-400 hover:text-white transition-colors"
              >
                <Plus size={12} /> Add chat
              </button>
            </div>

            <AnimatePresence>
              {showAddChat && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-3 overflow-hidden"
                >
                  <div className="flex gap-2">
                    <input
                      value={newChatId}
                      onChange={e => setNewChatId(e.target.value)}
                      placeholder="Chat ID (e.g. 1234567890@c.us)"
                      className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
                    />
                    <button
                      onClick={handleAddChat}
                      disabled={addingChat || !newChatId.trim()}
                      className="px-3 py-2 text-xs font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
                    >
                      {addingChat ? 'Adding...' : 'Add'}
                    </button>
                    <button
                      onClick={() => { setShowAddChat(false); setNewChatId(''); }}
                      className="text-neutral-500 hover:text-white transition-colors px-2"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <p className="text-xs text-neutral-500">
              Agents will only respond to messages from allowed chats. If none are added, all chats are accessible.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
