/**
 * Trigger Constants
 *
 * Known GHL event types, action types, and contact field definitions
 * for the automations UI and trigger system.
 */

export interface GhlEventType {
  value: string;
  label: string;
  category: string;
  sampleFields: string[];
}

export interface ActionType {
  value: string;
  label: string;
  description: string;
}

export interface ContactField {
  value: string;
  label: string;
}

export const GHL_EVENT_TYPES: GhlEventType[] = [
  // Custom
  { value: 'custom', label: 'Custom Webhook', category: 'Custom', sampleFields: [] },

  // Contacts
  { value: 'ContactCreate', label: 'Contact Created', category: 'Contacts', sampleFields: ['contact_name', 'email', 'phone', 'company_name', 'tags', 'source'] },
  { value: 'ContactUpdate', label: 'Contact Updated', category: 'Contacts', sampleFields: ['contact_name', 'email', 'phone', 'company_name', 'tags'] },
  { value: 'ContactDelete', label: 'Contact Deleted', category: 'Contacts', sampleFields: ['contact_id', 'contact_name', 'email'] },
  { value: 'ContactDndUpdate', label: 'Contact DND Updated', category: 'Contacts', sampleFields: ['contact_id', 'dndSettings'] },
  { value: 'ContactTagUpdate', label: 'Contact Tag Updated', category: 'Contacts', sampleFields: ['contact_id', 'tags'] },

  // Opportunities
  { value: 'OpportunityCreate', label: 'Opportunity Created', category: 'Opportunities', sampleFields: ['opportunity_name', 'monetary_value', 'pipeline_id', 'stage_id', 'contact_id'] },
  { value: 'OpportunityUpdate', label: 'Opportunity Updated', category: 'Opportunities', sampleFields: ['opportunity_name', 'monetary_value', 'pipeline_id', 'stage_id', 'status'] },
  { value: 'OpportunityDelete', label: 'Opportunity Deleted', category: 'Opportunities', sampleFields: ['opportunity_id', 'opportunity_name'] },
  { value: 'OpportunityStageUpdate', label: 'Opportunity Stage Changed', category: 'Opportunities', sampleFields: ['opportunity_id', 'stage_id', 'previous_stage_id'] },
  { value: 'OpportunityStatusUpdate', label: 'Opportunity Status Changed', category: 'Opportunities', sampleFields: ['opportunity_id', 'status', 'previous_status'] },
  { value: 'OpportunityMonetaryValueUpdate', label: 'Opportunity Value Changed', category: 'Opportunities', sampleFields: ['opportunity_id', 'monetary_value', 'previous_monetary_value'] },

  // Appointments
  { value: 'AppointmentCreate', label: 'Appointment Created', category: 'Appointments', sampleFields: ['appointment_id', 'contact_id', 'calendar_id', 'start_time', 'end_time', 'title'] },
  { value: 'AppointmentUpdate', label: 'Appointment Updated', category: 'Appointments', sampleFields: ['appointment_id', 'contact_id', 'start_time', 'end_time', 'status'] },
  { value: 'AppointmentDelete', label: 'Appointment Deleted', category: 'Appointments', sampleFields: ['appointment_id'] },

  // Tasks
  { value: 'TaskCreate', label: 'Task Created', category: 'Tasks', sampleFields: ['task_id', 'title', 'body', 'assignedTo', 'dueDate', 'contact_id'] },
  { value: 'TaskComplete', label: 'Task Completed', category: 'Tasks', sampleFields: ['task_id', 'title', 'completed_at'] },
  { value: 'TaskDelete', label: 'Task Deleted', category: 'Tasks', sampleFields: ['task_id'] },

  // Notes
  { value: 'NoteCreate', label: 'Note Created', category: 'Notes', sampleFields: ['note_id', 'body', 'contact_id'] },
  { value: 'NoteUpdate', label: 'Note Updated', category: 'Notes', sampleFields: ['note_id', 'body'] },
  { value: 'NoteDelete', label: 'Note Deleted', category: 'Notes', sampleFields: ['note_id'] },

  // Conversations
  { value: 'InboundMessage', label: 'Inbound Message', category: 'Conversations', sampleFields: ['message_id', 'contact_id', 'body', 'type', 'direction'] },
  { value: 'OutboundMessage', label: 'Outbound Message', category: 'Conversations', sampleFields: ['message_id', 'contact_id', 'body', 'type'] },

  // Forms
  { value: 'FormSubmission', label: 'Form Submitted', category: 'Forms', sampleFields: ['form_id', 'form_name', 'contact_id', 'fields'] },

  // Payments
  { value: 'InvoiceCreate', label: 'Invoice Created', category: 'Payments', sampleFields: ['invoice_id', 'contact_id', 'amount', 'currency', 'status'] },
  { value: 'InvoiceUpdate', label: 'Invoice Updated', category: 'Payments', sampleFields: ['invoice_id', 'status', 'amount_due'] },
  { value: 'PaymentReceived', label: 'Payment Received', category: 'Payments', sampleFields: ['payment_id', 'invoice_id', 'amount', 'contact_id'] },
];

export const ACTION_TYPES: ActionType[] = [
  { value: 'run_agent', label: 'Run Agent', description: 'Assign a task to an AI agent with context from the webhook' },
  { value: 'agent_prompt', label: 'AI Agent Prompt', description: 'Have an AI agent process data and generate a response' },
  { value: 'a2a_call', label: 'External Agent (A2A)', description: 'Call an external agent via the A2A protocol' },
  { value: 'save_contact', label: 'Save Contact', description: 'Create or update a contact from webhook data' },
  { value: 'update_contact', label: 'Update Contact', description: 'Find and update an existing contact by email or phone' },
  { value: 'log_contact_event', label: 'Log Contact Event', description: 'Add a timeline event to an existing contact' },
  { value: 'webhook_forward', label: 'Forward Webhook', description: 'Forward the webhook data to an external URL' },
  { value: 'transform_data', label: 'Transform Data', description: 'Transform and reshape data between steps' },
  { value: 'conditional', label: 'Conditional', description: 'Branch execution based on a condition' },
  { value: 'run_workflow', label: 'Run Workflow', description: 'Execute a multi-agent workflow pipeline' },
];

export const CONTACT_FIELDS: ContactField[] = [
  { value: 'name', label: 'Name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'company', label: 'Company' },
  { value: 'notes', label: 'Notes' },
  { value: 'contact_type', label: 'Contact Type' },
];
