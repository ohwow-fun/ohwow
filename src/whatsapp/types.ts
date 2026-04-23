/**
 * WhatsApp Integration Types
 */

export type WhatsAppConnectionStatus = 'disconnected' | 'qr_pending' | 'connected';

export interface WhatsAppConnection {
  id: string;
  workspace_id: string;
  phone_number: string | null;
  status: WhatsAppConnectionStatus;
  auth_state: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppAllowedChat {
  id: string;
  connection_id: string;
  chat_id: string;
  chat_name: string | null;
  chat_type: 'individual' | 'group';
  contact_id: string | null;
  team_member_id: string | null;
  created_at: string;
}

export interface WhatsAppMessage {
  id: string;
  connection_id: string;
  chat_id: string;
  sender: string | null;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}
