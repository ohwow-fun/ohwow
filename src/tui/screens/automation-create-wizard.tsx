/**
 * Automation Create/Edit Wizard
 * Multi-step wizard for creating or editing a trigger.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { LocalTriggerService } from '../../triggers/local-trigger-service.js';
import { GHL_EVENT_TYPES, ACTION_TYPES, CONTACT_FIELDS } from '../../triggers/trigger-constants.js';
import { InputField } from '../components/input-field.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { KeyHints } from '../components/key-hints.js';
import { MODEL_CATALOG } from '../../lib/ollama-models.js';

const IMAGE_KEYWORDS = /image|photo|picture|attachment|media|screenshot|scan|ocr/i;

function hasImageTerms(text: string): boolean {
  return IMAGE_KEYWORDS.test(text);
}

interface AutomationCreateWizardProps {
  db: DatabaseAdapter | null;
  editTriggerId?: string | null;
  ollamaModel?: string;
  hasAnthropicApiKey?: boolean;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'name' | 'eventType' | 'actionType' | 'webhookUrl' | 'waitForTest' | 'actionConfig' | 'cooldown' | 'confirm' | 'saving' | 'done';
const STANDARD_STEPS: Step[] = ['name', 'eventType', 'actionType', 'actionConfig', 'cooldown', 'confirm', 'saving', 'done'];
const CUSTOM_STEPS: Step[] = ['name', 'eventType', 'actionType', 'webhookUrl', 'waitForTest', 'actionConfig', 'cooldown', 'confirm', 'saving', 'done'];
const STANDARD_VISIBLE = 6;
const CUSTOM_VISIBLE = 8;

export function AutomationCreateWizard({ db, editTriggerId, ollamaModel, hasAnthropicApiKey, onComplete, onCancel }: AutomationCreateWizardProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!editTriggerId);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [eventType, setEventType] = useState('');
  const [actionType, setActionType] = useState('');
  const [cooldown, setCooldown] = useState('60');

  // Custom webhook state
  const [savedTriggerId, setSavedTriggerId] = useState<string | null>(null);
  const [generatedWebhookUrl, setGeneratedWebhookUrl] = useState('');
  const [discoveredFields, setDiscoveredFields] = useState<string[]>([]);
  const [waitingForTest, setWaitingForTest] = useState(false);

  // Action config fields
  const [agentId, setAgentId] = useState('');
  const [promptTemplate, setPromptTemplate] = useState('');
  const [contactType, setContactType] = useState('lead');
  const [fieldMappings, setFieldMappings] = useState<Array<{ field: string; path: string }>>([]);
  const [matchField, setMatchField] = useState('email');
  const [matchValuePath, setMatchValuePath] = useState('');
  const [eventTypeConfig, setEventTypeConfig] = useState('note');
  const [titleTemplate, setTitleTemplate] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookMethod, setWebhookMethod] = useState('POST');

  // Agent list for run_agent action
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);

  // Sub-step tracking for action config
  const [configSubStep, setConfigSubStep] = useState(0);

  const isCustom = eventType === 'custom';
  const STEPS = isCustom ? CUSTOM_STEPS : STANDARD_STEPS;
  const VISIBLE_STEPS = isCustom ? CUSTOM_VISIBLE : STANDARD_VISIBLE;
  const step = STEPS[stepIndex];
  const isEdit = !!editTriggerId;

  // Load existing trigger for edit mode
  useEffect(() => {
    if (!db || !editTriggerId) return;
    const service = new LocalTriggerService(db);

    const load = async () => {
      const trigger = await service.getById(editTriggerId);
      if (trigger) {
        setName(trigger.name);
        setDescription(trigger.description || '');
        setEventType(trigger.event_type);
        setActionType(trigger.action_type);
        setCooldown(String(trigger.cooldown_seconds));

        const config = parseJson(trigger.action_config);
        if (trigger.action_type === 'run_agent') {
          setAgentId((config.agent_id as string) || '');
          setPromptTemplate((config.prompt_template as string) || '');
        } else if (trigger.action_type === 'save_contact') {
          setContactType((config.contact_type as string) || 'lead');
          setFieldMappings((config.field_mappings as Array<{ field: string; path: string }>) || []);
        } else if (trigger.action_type === 'update_contact') {
          setMatchField((config.match_field as string) || 'email');
          setMatchValuePath((config.match_value_path as string) || '');
          setFieldMappings((config.field_mappings as Array<{ field: string; path: string }>) || []);
        } else if (trigger.action_type === 'log_contact_event') {
          setMatchField((config.match_field as string) || 'email');
          setMatchValuePath((config.match_value_path as string) || '');
          setEventTypeConfig((config.event_type as string) || 'note');
          setTitleTemplate((config.title_template as string) || '');
        } else if (trigger.action_type === 'webhook_forward') {
          setWebhookUrl((config.url as string) || '');
          setWebhookMethod((config.method as string) || 'POST');
        }
      }
      setLoading(false);
    };

    load();
  }, [db, editTriggerId]);

  // Load agents for run_agent action
  useEffect(() => {
    if (!db) return;
    const fetchAgents = async () => {
      const { data } = await db.from('agent_workforce_agents').select('id, name').order('name', { ascending: true });
      if (data) setAgents(data as Array<{ id: string; name: string }>);
    };
    fetchAgents();
  }, [db]);

  const nextStep = () => { setError(''); setConfigSubStep(0); setStepIndex(i => Math.min(i + 1, (isCustom ? CUSTOM_STEPS : STANDARD_STEPS).length - 1)); };
  const prevStep = () => { setError(''); setConfigSubStep(0); setStepIndex(i => Math.max(i - 1, 0)); };

  const buildActionConfig = (): Record<string, unknown> => {
    switch (actionType) {
      case 'run_agent':
        return { agent_id: agentId, prompt_template: promptTemplate };
      case 'save_contact':
        return { contact_type: contactType, field_mappings: fieldMappings };
      case 'update_contact':
        return { match_field: matchField, match_value_path: matchValuePath, field_mappings: fieldMappings };
      case 'log_contact_event':
        return { match_field: matchField, match_value_path: matchValuePath, event_type: eventTypeConfig, title_template: titleTemplate };
      case 'webhook_forward':
        return { url: webhookUrl, method: webhookMethod };
      default:
        return {};
    }
  };

  /** Save the trigger early (disabled) for custom webhooks to generate the URL */
  const handleEarlySave = async (overrideActionType?: string) => {
    if (!db) return;
    setError('');

    try {
      const service = new LocalTriggerService(db);
      const actualActionType = overrideActionType || actionType;

      const trigger = await service.create({
        name: name.trim(),
        description: description.trim(),
        event_type: eventType,
        action_type: actualActionType,
        action_config: {},
        cooldown_seconds: parseInt(cooldown, 10) || 60,
      });

      setSavedTriggerId(trigger.id);

      // Build webhook URL
      const { data: tunnelSetting } = await db.from('runtime_settings')
        .select('value')
        .eq('key', 'tunnel_url')
        .maybeSingle();

      const baseUrl = tunnelSetting
        ? (tunnelSetting as { value: string }).value
        : `http://localhost:4800`;

      setGeneratedWebhookUrl(`${baseUrl}/webhooks/incoming/${trigger.webhook_token}`);
      nextStep();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  };

  const handleSave = async () => {
    if (!db) return;
    const steps = isCustom ? CUSTOM_STEPS : STANDARD_STEPS;
    setStepIndex(steps.indexOf('saving'));
    setError('');

    try {
      const service = new LocalTriggerService(db);
      const config = buildActionConfig();

      if (savedTriggerId) {
        // Custom webhook: update the already-saved trigger and enable it
        await service.update(savedTriggerId, {
          name: name.trim(),
          description: description.trim(),
          event_type: eventType,
          action_type: actionType,
          action_config: config,
          cooldown_seconds: parseInt(cooldown, 10) || 60,
          enabled: true,
        });
      } else if (isEdit && editTriggerId) {
        await service.update(editTriggerId, {
          name: name.trim(),
          description: description.trim(),
          event_type: eventType,
          action_type: actionType,
          action_config: config,
          cooldown_seconds: parseInt(cooldown, 10) || 60,
        });
      } else {
        await service.create({
          name: name.trim(),
          description: description.trim(),
          event_type: eventType,
          action_type: actionType,
          action_config: config,
          cooldown_seconds: parseInt(cooldown, 10) || 60,
        });
      }

      setStepIndex(steps.indexOf('done'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setStepIndex(steps.indexOf('confirm'));
    }
  };

  // Poll for test payload on waitForTest step
  useEffect(() => {
    if (step !== 'waitForTest' || !db || !savedTriggerId) return;

    const service = new LocalTriggerService(db);
    let cancelled = false;

    const poll = () => {
      const interval = setInterval(async () => {
        if (cancelled) { clearInterval(interval); return; }
        const { sampleFields } = await service.getSampleData(savedTriggerId);
        if (sampleFields.length > 0 && !cancelled) {
          setDiscoveredFields(sampleFields);
          setWaitingForTest(false);
          clearInterval(interval);
        }
      }, 2000);
      return interval;
    };

    const interval = poll();
    return () => { cancelled = true; clearInterval(interval); };
  }, [step, db, savedTriggerId]);

  useInput((input, key) => {
    if (step === 'saving') return;

    if (key.escape) {
      if (step === 'done') { onComplete(); return; }
      // On waitForTest, skip to actionConfig
      if (step === 'waitForTest') { setWaitingForTest(false); nextStep(); return; }
      // Don't go back past webhookUrl (trigger already saved)
      if (step === 'webhookUrl') { nextStep(); return; }
      if (stepIndex > 0) { prevStep(); } else { onCancel(); }
      return;
    }

    if (step === 'webhookUrl' && key.return) { nextStep(); return; }
    if (step === 'waitForTest' && key.return && discoveredFields.length > 0) { nextStep(); return; }
    if (step === 'confirm' && key.return) { handleSave(); return; }
    if (step === 'done' && key.return) { onComplete(); return; }
  });

  if (loading) {
    return <Text color="gray">Loading trigger...</Text>;
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">{isEdit ? 'Edit Trigger' : 'New Trigger'}</Text>
        <Text color="gray"> — Step {Math.min(stepIndex + 1, VISIBLE_STEPS)} of {VISIBLE_STEPS}</Text>
      </Box>

      {/* Progress dots */}
      <Box marginBottom={1}>
        {STEPS.slice(0, VISIBLE_STEPS).map((_, i) => (
          <Text key={i} color={i < stepIndex ? 'green' : i === stepIndex ? 'cyan' : 'gray'}>
            {i < stepIndex ? '●' : i === stepIndex ? '◉' : '○'}{' '}
          </Text>
        ))}
      </Box>

      {/* Step: Name + Description */}
      {step === 'name' && (
        <Box flexDirection="column">
          <Text bold>Name and Description</Text>
          <Text color="gray">Give your trigger a name and optional description.</Text>
          <Box marginTop={1}>
            {!name.trim() || configSubStep === 0 ? (
              <InputField
                label="Name"
                value={name}
                onChange={setName}
                placeholder="e.g. New Contact Alert"
                onSubmit={() => {
                  if (!name.trim()) { setError('Give your trigger a name'); return; }
                  setConfigSubStep(1);
                }}
              />
            ) : (
              <InputField
                label="Description"
                value={description}
                onChange={setDescription}
                placeholder="Optional description"
                onSubmit={() => nextStep()}
              />
            )}
          </Box>
          {configSubStep === 1 && (
            <Text color="gray">  Name: {name}</Text>
          )}
        </Box>
      )}

      {/* Step: Event Type */}
      {step === 'eventType' && (
        <Box flexDirection="column">
          <Text bold>Event Type</Text>
          <Text color="gray">Which webhook event should trigger this automation?</Text>
          <Box marginTop={1}>
            <ScrollableList
              items={GHL_EVENT_TYPES}
              onSelect={(evt) => { setEventType(evt.value); nextStep(); }}
              renderItem={(evt, _, isSelected) => (
                <Box>
                  <Text bold={isSelected}>
                    <Text color="gray">[{evt.category}]</Text> {evt.label}
                  </Text>
                </Box>
              )}
            />
          </Box>
        </Box>
      )}

      {/* Step: Webhook URL (custom only) — save trigger and show URL */}
      {step === 'webhookUrl' && (
        <Box flexDirection="column">
          <Text bold>Webhook URL</Text>
          {!generatedWebhookUrl ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow">Saving trigger to generate webhook URL...</Text>
              {!savedTriggerId && <Text color="gray">This will happen automatically...</Text>}
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text color="green">Your webhook URL is ready:</Text>
              <Box marginTop={1} paddingX={1}>
                <Text color="cyan" bold>{generatedWebhookUrl}</Text>
              </Box>
              <Box marginTop={1}>
                <Text color="gray">Copy this URL and paste it in your GHL workflow&apos;s Custom Webhook action.</Text>
              </Box>
              <Box marginTop={1}>
                <Text color="gray">Then send a test from GHL. Press <Text bold color="white">Enter</Text> to continue.</Text>
              </Box>
            </Box>
          )}
        </Box>
      )}

      {/* Step: Wait for Test (custom only) */}
      {step === 'waitForTest' && (
        <Box flexDirection="column">
          <Text bold>Test Webhook</Text>
          {waitingForTest && discoveredFields.length === 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow">Waiting for a test webhook...</Text>
              <Text color="gray">Send a test request from GHL to discover available fields.</Text>
              <Text color="gray">Press <Text bold color="white">Esc</Text> to skip and configure manually.</Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text color="green">Test received! Discovered {discoveredFields.length} {discoveredFields.length === 1 ? 'field' : 'fields'}:</Text>
              <Box flexDirection="column" marginTop={1} paddingX={1}>
                {discoveredFields.slice(0, 15).map((field, i) => (
                  <Text key={i} color="gray">  {field}</Text>
                ))}
                {discoveredFields.length > 15 && (
                  <Text color="gray">  ...and {discoveredFields.length - 15} more</Text>
                )}
              </Box>
              <Box marginTop={1}>
                <Text color="gray">Press <Text bold color="white">Enter</Text> to continue to field mapping.</Text>
              </Box>
            </Box>
          )}
        </Box>
      )}

      {/* Step: Action Type */}
      {step === 'actionType' && (
        <Box flexDirection="column">
          <Text bold>Action Type</Text>
          <Text color="gray">What should happen when this event fires?</Text>
          <Box marginTop={1}>
            <ScrollableList
              items={ACTION_TYPES}
              onSelect={(act) => {
                setActionType(act.value);
                setConfigSubStep(0);
                if (eventType === 'custom') {
                  // For custom webhooks, save early to generate webhook URL
                  handleEarlySave(act.value);
                } else {
                  nextStep();
                }
              }}
              renderItem={(act, _, isSelected) => (
                <Box>
                  <Text bold={isSelected}>{act.label.padEnd(20)}</Text>
                  <Text color="gray">{act.description}</Text>
                </Box>
              )}
            />
          </Box>
        </Box>
      )}

      {/* Step: Action Config */}
      {step === 'actionConfig' && (
        <Box flexDirection="column">
          <Text bold>Action Config</Text>
          <Text color="gray">Configure the action details.</Text>
          <Box marginTop={1} flexDirection="column">
            {renderActionConfig({
              actionType, configSubStep, setConfigSubStep,
              agents, agentId, setAgentId,
              promptTemplate, setPromptTemplate,
              contactType, setContactType,
              fieldMappings, setFieldMappings,
              matchField, setMatchField,
              matchValuePath, setMatchValuePath,
              eventTypeConfig, setEventTypeConfig,
              titleTemplate, setTitleTemplate,
              webhookUrl, setWebhookUrl,
              webhookMethod, setWebhookMethod,
              ollamaModel, hasAnthropicApiKey,
              onDone: nextStep,
            })}
          </Box>
        </Box>
      )}

      {/* Step: Cooldown */}
      {step === 'cooldown' && (
        <Box flexDirection="column">
          <Text bold>Cooldown</Text>
          <Text color="gray">Minimum seconds between trigger fires (prevents duplicates).</Text>
          <Box marginTop={1}>
            <InputField
              label="Seconds"
              value={cooldown}
              onChange={setCooldown}
              placeholder="60"
              onSubmit={() => nextStep()}
            />
          </Box>
        </Box>
      )}

      {/* Step: Confirm */}
      {step === 'confirm' && (
        <Box flexDirection="column">
          <Text bold>Review</Text>
          <Box flexDirection="column" marginTop={1} paddingX={1}>
            <Text><Text bold>Name:</Text> {name}</Text>
            {description && <Text><Text bold>Description:</Text> {description}</Text>}
            <Text><Text bold>Event:</Text> <Text color="cyan">{getEventLabel(eventType)}</Text></Text>
            <Text><Text bold>Action:</Text> <Text color="magenta">{getActionLabel(actionType)}</Text></Text>
            <Text><Text bold>Cooldown:</Text> {cooldown}s</Text>
          </Box>
          {(actionType === 'run_agent' || actionType === 'agent_prompt') && hasImageTerms(promptTemplate) && (
            <Box marginTop={1}>
              <VisionHint ollamaModel={ollamaModel} hasAnthropicApiKey={hasAnthropicApiKey} />
            </Box>
          )}
          <Box marginTop={1}>
            <Text color="gray">Press <Text bold color="white">Enter</Text> to {isEdit ? 'save' : 'create'}, <Text bold>Esc</Text> to edit</Text>
          </Box>
        </Box>
      )}

      {/* Step: Saving */}
      {step === 'saving' && (
        <Box marginTop={1}>
          <Text color="yellow">{isEdit ? 'Saving trigger...' : 'Creating trigger...'}</Text>
        </Box>
      )}

      {/* Step: Done */}
      {step === 'done' && (
        <Box flexDirection="column">
          <Text bold color="green">Trigger {isEdit ? 'updated' : 'created'}!</Text>
          <Text color="gray">{name} is ready to fire.</Text>
          <Text color="gray">Press Esc to go back.</Text>
        </Box>
      )}

      {error && <Text color="red">{error}</Text>}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            ...(stepIndex > 0 && step !== 'saving' && step !== 'done' ? [{ key: 'Esc', label: 'Back' }] : step === 'name' ? [{ key: 'Esc', label: 'Cancel' }] : []),
            ...(step === 'confirm' ? [{ key: 'Enter', label: isEdit ? 'Save' : 'Create' }] : []),
            ...(step === 'done' ? [{ key: 'Esc', label: 'Back' }] : []),
          ]}
        />
      </Box>
    </Box>
  );
}

// ============================================================================
// Action Config Sub-Renderers
// ============================================================================

interface ActionConfigProps {
  actionType: string;
  configSubStep: number;
  setConfigSubStep: (n: number) => void;
  agents: Array<{ id: string; name: string }>;
  agentId: string;
  setAgentId: (v: string) => void;
  promptTemplate: string;
  setPromptTemplate: (v: string) => void;
  contactType: string;
  setContactType: (v: string) => void;
  fieldMappings: Array<{ field: string; path: string }>;
  setFieldMappings: (v: Array<{ field: string; path: string }>) => void;
  matchField: string;
  setMatchField: (v: string) => void;
  matchValuePath: string;
  setMatchValuePath: (v: string) => void;
  eventTypeConfig: string;
  setEventTypeConfig: (v: string) => void;
  titleTemplate: string;
  setTitleTemplate: (v: string) => void;
  webhookUrl: string;
  setWebhookUrl: (v: string) => void;
  webhookMethod: string;
  setWebhookMethod: (v: string) => void;
  ollamaModel?: string;
  hasAnthropicApiKey?: boolean;
  onDone: () => void;
}

function renderActionConfig(props: ActionConfigProps): React.ReactNode {
  switch (props.actionType) {
    case 'run_agent':
      return <RunAgentConfig {...props} />;
    case 'save_contact':
      return <SaveContactConfig {...props} />;
    case 'update_contact':
      return <UpdateContactConfig {...props} />;
    case 'log_contact_event':
      return <LogContactEventConfig {...props} />;
    case 'webhook_forward':
      return <WebhookForwardConfig {...props} />;
    default:
      return <Text color="gray">No config needed. Press Enter to continue.</Text>;
  }
}

function RunAgentConfig({ configSubStep, setConfigSubStep, agents, agentId, setAgentId, promptTemplate, setPromptTemplate, ollamaModel, hasAnthropicApiKey, onDone }: ActionConfigProps) {
  if (configSubStep === 0) {
    return (
      <Box flexDirection="column">
        <Text>Select an agent:</Text>
        <ScrollableList
          items={agents}
          onSelect={(agent) => { setAgentId(agent.id); setConfigSubStep(1); }}
          emptyMessage="No agents. Create one first."
          renderItem={(agent, _, isSelected) => (
            <Text bold={isSelected}>{agent.name}</Text>
          )}
        />
      </Box>
    );
  }

  const selectedAgent = agents.find(a => a.id === agentId);
  return (
    <Box flexDirection="column">
      <Text color="gray">Agent: {selectedAgent?.name || agentId}</Text>
      <InputField
        label="Prompt template"
        value={promptTemplate}
        onChange={setPromptTemplate}
        placeholder="Process this webhook: {{data}}"
        onSubmit={() => onDone()}
      />
      {hasImageTerms(promptTemplate) && (
        <Box marginTop={1}>
          <VisionHint ollamaModel={ollamaModel} hasAnthropicApiKey={hasAnthropicApiKey} />
        </Box>
      )}
    </Box>
  );
}

function SaveContactConfig({ configSubStep, setConfigSubStep, contactType, setContactType, fieldMappings, setFieldMappings, onDone }: ActionConfigProps) {
  const contactTypes = [
    { id: 'lead', name: 'Lead' },
    { id: 'customer', name: 'Customer' },
    { id: 'partner', name: 'Partner' },
    { id: 'other', name: 'Other' },
  ];

  if (configSubStep === 0) {
    return (
      <Box flexDirection="column">
        <Text>Select contact type:</Text>
        <ScrollableList
          items={contactTypes}
          onSelect={(ct) => { setContactType(ct.id); setConfigSubStep(1); }}
          renderItem={(ct, _, isSelected) => (
            <Text bold={isSelected}>{ct.name}</Text>
          )}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="gray">Type: {contactType}</Text>
      <Text color="gray">Field mappings ({fieldMappings.length}):</Text>
      {fieldMappings.map((m, i) => (
        <Text key={i} color="gray">  {m.field} ← {m.path}</Text>
      ))}
      <FieldMappingInput
        onAdd={(field, path) => setFieldMappings([...fieldMappings, { field, path }])}
        onDone={onDone}
      />
    </Box>
  );
}

function UpdateContactConfig({ configSubStep, setConfigSubStep, matchField, setMatchField, matchValuePath, setMatchValuePath, fieldMappings, setFieldMappings, onDone }: ActionConfigProps) {
  if (configSubStep === 0) {
    return (
      <Box flexDirection="column">
        <Text>Match contacts by:</Text>
        <ScrollableList
          items={CONTACT_FIELDS.filter(f => ['email', 'phone', 'name'].includes(f.value))}
          onSelect={(f) => { setMatchField(f.value); setConfigSubStep(1); }}
          renderItem={(f, _, isSelected) => (
            <Text bold={isSelected}>{f.label}</Text>
          )}
        />
      </Box>
    );
  }

  if (configSubStep === 1) {
    return (
      <Box flexDirection="column">
        <Text color="gray">Match by: {matchField}</Text>
        <InputField
          label="Value path"
          value={matchValuePath}
          onChange={setMatchValuePath}
          placeholder="e.g. data.email"
          onSubmit={() => {
            if (!matchValuePath.trim()) return;
            setConfigSubStep(2);
          }}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="gray">Match: {matchField} from {matchValuePath}</Text>
      <Text color="gray">Field mappings ({fieldMappings.length}):</Text>
      {fieldMappings.map((m, i) => (
        <Text key={i} color="gray">  {m.field} ← {m.path}</Text>
      ))}
      <FieldMappingInput
        onAdd={(field, path) => setFieldMappings([...fieldMappings, { field, path }])}
        onDone={onDone}
      />
    </Box>
  );
}

function LogContactEventConfig({ configSubStep, setConfigSubStep, matchField, setMatchField, matchValuePath, setMatchValuePath, eventTypeConfig, setEventTypeConfig, titleTemplate, setTitleTemplate, onDone }: ActionConfigProps) {
  const eventTypes = [
    { id: 'note', name: 'Note' },
    { id: 'call', name: 'Call' },
    { id: 'meeting', name: 'Meeting' },
    { id: 'email', name: 'Email' },
    { id: 'task', name: 'Task' },
    { id: 'other', name: 'Other' },
  ];

  if (configSubStep === 0) {
    return (
      <Box flexDirection="column">
        <Text>Match contacts by:</Text>
        <ScrollableList
          items={CONTACT_FIELDS.filter(f => ['email', 'phone', 'name'].includes(f.value))}
          onSelect={(f) => { setMatchField(f.value); setConfigSubStep(1); }}
          renderItem={(f, _, isSelected) => (
            <Text bold={isSelected}>{f.label}</Text>
          )}
        />
      </Box>
    );
  }

  if (configSubStep === 1) {
    return (
      <Box flexDirection="column">
        <Text color="gray">Match by: {matchField}</Text>
        <InputField
          label="Value path"
          value={matchValuePath}
          onChange={setMatchValuePath}
          placeholder="e.g. data.email"
          onSubmit={() => {
            if (!matchValuePath.trim()) return;
            setConfigSubStep(2);
          }}
        />
      </Box>
    );
  }

  if (configSubStep === 2) {
    return (
      <Box flexDirection="column">
        <Text color="gray">Match: {matchField} from {matchValuePath}</Text>
        <Text>Event type:</Text>
        <ScrollableList
          items={eventTypes}
          onSelect={(et) => { setEventTypeConfig(et.id); setConfigSubStep(3); }}
          renderItem={(et, _, isSelected) => (
            <Text bold={isSelected}>{et.name}</Text>
          )}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="gray">Match: {matchField} from {matchValuePath}, type: {eventTypeConfig}</Text>
      <InputField
        label="Title template"
        value={titleTemplate}
        onChange={setTitleTemplate}
        placeholder="e.g. New {{type}} from webhook"
        onSubmit={() => {
          if (!titleTemplate.trim()) return;
          onDone();
        }}
      />
    </Box>
  );
}

function WebhookForwardConfig({ configSubStep, setConfigSubStep, webhookUrl, setWebhookUrl, setWebhookMethod, onDone }: ActionConfigProps) {
  const methods = [
    { id: 'POST', name: 'POST' },
    { id: 'PUT', name: 'PUT' },
  ];

  if (configSubStep === 0) {
    return (
      <Box flexDirection="column">
        <InputField
          label="Webhook URL"
          value={webhookUrl}
          onChange={setWebhookUrl}
          placeholder="https://example.com/webhook"
          onSubmit={() => {
            if (!webhookUrl.trim()) return;
            setConfigSubStep(1);
          }}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="gray">URL: {webhookUrl}</Text>
      <Text>HTTP method:</Text>
      <ScrollableList
        items={methods}
        onSelect={(m) => { setWebhookMethod(m.id); onDone(); }}
        renderItem={(m, _, isSelected) => (
          <Text bold={isSelected}>{m.name}</Text>
        )}
      />
    </Box>
  );
}

// ============================================================================
// Field Mapping Input (reusable for save_contact / update_contact)
// ============================================================================

interface FieldMappingInputProps {
  onAdd: (field: string, path: string) => void;
  onDone: () => void;
}

function FieldMappingInput({ onAdd, onDone }: FieldMappingInputProps) {
  const [subStep, setSubStep] = useState<'field' | 'path' | 'more'>('field');
  const [selectedField, setSelectedField] = useState('');
  const [path, setPath] = useState('');

  if (subStep === 'field') {
    return (
      <Box flexDirection="column">
        <Text>Add field mapping (or press Esc when done):</Text>
        <ScrollableList
          items={[...CONTACT_FIELDS, { value: '_done', label: 'Done (no more mappings)' }]}
          onSelect={(f) => {
            if (f.value === '_done') { onDone(); return; }
            setSelectedField(f.value);
            setSubStep('path');
          }}
          renderItem={(f, _, isSelected) => (
            <Text bold={isSelected} color={f.value === '_done' ? 'green' : undefined}>{f.label}</Text>
          )}
        />
      </Box>
    );
  }

  if (subStep === 'path') {
    return (
      <Box flexDirection="column">
        <Text color="gray">Field: {selectedField}</Text>
        <InputField
          label="Data path"
          value={path}
          onChange={setPath}
          placeholder="e.g. data.contact_name"
          onSubmit={() => {
            if (!path.trim()) return;
            onAdd(selectedField, path.trim());
            setPath('');
            setSelectedField('');
            setSubStep('field');
          }}
        />
      </Box>
    );
  }

  return null;
}

// ============================================================================
// Helpers
// ============================================================================

function getEventLabel(eventType: string): string {
  return GHL_EVENT_TYPES.find(e => e.value === eventType)?.label || eventType;
}

function getActionLabel(actionType: string): string {
  return ACTION_TYPES.find(a => a.value === actionType)?.label || actionType;
}

function VisionHint({ ollamaModel, hasAnthropicApiKey }: { ollamaModel?: string; hasAnthropicApiKey?: boolean }) {
  const catalogEntry = ollamaModel ? MODEL_CATALOG.find(m => m.tag === ollamaModel) : null;
  const hasLocalVision = catalogEntry?.vision ?? false;

  if (hasLocalVision) {
    return <Text color="green">This agent can analyze images using {catalogEntry?.label}</Text>;
  }
  if (hasAnthropicApiKey) {
    return <Text color="cyan">Image analysis available via Claude</Text>;
  }
  return <Text color="yellow">Your current setup cannot process images. Set up a vision model in Settings, or add an Anthropic API key.</Text>;
}

function parseJson(val: unknown): Record<string, unknown> {
  if (typeof val === 'object' && val !== null) return val as Record<string, unknown>;
  try {
    return JSON.parse(val as string) as Record<string, unknown>;
  } catch {
    return {};
  }
}
