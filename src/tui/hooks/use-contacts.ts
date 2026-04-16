/**
 * useContacts Hook
 * Queries contacts from SQLite with periodic refresh.
 */

import { useState, useEffect } from 'react';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { ContactRow } from '../types.js';

interface ParsedContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  contactType: string;
  status: string;
  notes: string | null;
  created_at: string;
}

export function useContacts(db: DatabaseAdapter | null, workspaceId: string | null | undefined) {
  const [list, setList] = useState<ParsedContact[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    if (!db || !workspaceId) return;
    const { data } = await db
      .from<ContactRow>('agent_workforce_contacts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false });

    if (data) {
      const contacts = data.map(c => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        company: c.company,
        contactType: c.contact_type,
        status: c.status,
        notes: c.notes,
        created_at: c.created_at,
      }));
      setList(contacts);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!db || !workspaceId) return;

    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, workspaceId]);

  return { list, loading, refresh };
}
