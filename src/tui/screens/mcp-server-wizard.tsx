/**
 * McpServerWizard Screen
 * Step-based wizard for adding a new MCP server to an agent or globally.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { McpServerConfig, McpAuthConfig } from '../../mcp/types.js';
import { testMcpConnection } from '../../mcp/test-connection.js';
import type { McpTestResult } from '../../mcp/test-connection.js';
import { MCP_SERVER_CATALOG, CATALOG_CATEGORIES } from '../../mcp/catalog.js';
import type { McpCatalogEntry } from '../../mcp/catalog.js';
import { InputField } from '../components/input-field.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { KeyHints } from '../components/key-hints.js';

interface McpServerWizardProps {
  /** Agent ID — when set, saves to per-agent config. When null, saves to global runtime_settings. */
  agentId: string | null;
  db: DatabaseAdapter | null;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'source' | 'catalog' | 'transport' | 'name' | 'endpoint' | 'auth' | 'env' | 'confirm' | 'test';
const STEPS_STDIO: Step[] = ['source', 'transport', 'name', 'endpoint', 'env', 'confirm', 'test'];
const STEPS_HTTP: Step[]  = ['source', 'transport', 'name', 'endpoint', 'auth', 'confirm', 'test'];
const STEPS_CATALOG_WITH_ENV: Step[] = ['source', 'catalog', 'env', 'confirm', 'test'];
const STEPS_CATALOG_NO_ENV: Step[] = ['source', 'catalog', 'confirm', 'test'];

const TRANSPORT_OPTIONS = [
  { label: 'stdio (subprocess on this machine)', value: 'stdio' },
  { label: 'http (remote server via URL)', value: 'http' },
];

const SOURCE_OPTIONS = [
  { label: 'Browse popular servers', value: 'catalog' },
  { label: 'Configure manually', value: 'manual' },
];

/** Build a flat list of catalog entries for display. */
interface CatalogDisplayItem {
  type: 'entry';
  entry: McpCatalogEntry;
}

function buildCatalogItems(): CatalogDisplayItem[] {
  const items: CatalogDisplayItem[] = [];
  for (const cat of CATALOG_CATEGORIES) {
    const entries = MCP_SERVER_CATALOG.filter(e => e.category === cat.id);
    for (const entry of entries) {
      items.push({ type: 'entry', entry });
    }
  }
  return items;
}

const CATALOG_ITEMS = buildCatalogItems();

export function McpServerWizard({ agentId, db, onComplete, onCancel }: McpServerWizardProps) {
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [envRaw, setEnvRaw] = useState('');
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'api_key'>('none');
  const [authToken, setAuthToken] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [stepIndex, setStepIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [fromCatalog, setFromCatalog] = useState(false);
  const [catalogEntry, setCatalogEntry] = useState<McpCatalogEntry | null>(null);
  const [catalogEnvValues, setCatalogEnvValues] = useState<Record<string, string>>({});
  const [currentEnvIndex, setCurrentEnvIndex] = useState(0);

  const getSteps = (): Step[] => {
    if (fromCatalog) {
      const hasEnv = catalogEntry && catalogEntry.envVarsRequired.length > 0;
      return hasEnv ? STEPS_CATALOG_WITH_ENV : STEPS_CATALOG_NO_ENV;
    }
    return transport === 'stdio' ? STEPS_STDIO : STEPS_HTTP;
  };

  const steps = getSteps();
  const step = steps[stepIndex];

  const goToStep = (targetStep: Step) => {
    const currentSteps = getSteps();
    const idx = currentSteps.indexOf(targetStep);
    if (idx >= 0) {
      setError('');
      setStepIndex(idx);
    }
  };

  const nextStep = () => { setError(''); setStepIndex(i => Math.min(i + 1, getSteps().length - 1)); };
  const prevStep = () => { setError(''); setStepIndex(i => Math.max(i - 1, 0)); };

  const validate = (): string => {
    if (!name.trim()) return 'Name is required';
    if (transport === 'stdio' && !command.trim()) return 'Command is required';
    if (transport === 'http' && !url.trim()) return 'URL is required';
    return '';
  };

  const handleCatalogSelect = (item: CatalogDisplayItem) => {
    const entry = item.entry;
    setCatalogEntry(entry);
    setFromCatalog(true);
    setName(entry.name);
    setTransport(entry.transport);
    setCommand([entry.command, ...entry.args].join(' '));
    setCatalogEnvValues({});
    setCurrentEnvIndex(0);

    // Compute next steps based on the selected entry
    const hasEnv = entry.envVarsRequired.length > 0;
    const nextSteps = hasEnv ? STEPS_CATALOG_WITH_ENV : STEPS_CATALOG_NO_ENV;
    const targetStep = hasEnv ? 'env' : 'confirm';
    const idx = nextSteps.indexOf(targetStep);
    if (idx >= 0) {
      setError('');
      setStepIndex(idx);
    }
  };

  const save = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    if (!db) { setError('No database available'); return; }

    setSaving(true);
    setError('');
    try {
      // Merge catalog env values into envRaw if from catalog
      const envObj = fromCatalog && catalogEntry && catalogEntry.envVarsRequired.length > 0
        ? catalogEnvValues
        : (envRaw.trim() ? parseEnv(envRaw) : undefined);

      const authConfig: McpAuthConfig | undefined =
        transport === 'http' && authType === 'bearer' && authToken.trim()
          ? { type: 'bearer', token: authToken.trim() }
          : transport === 'http' && authType === 'api_key' && authKey.trim()
            ? { type: 'api_key', key: authKey.trim() }
            : undefined;

      const newServer: McpServerConfig = transport === 'stdio'
        ? {
            name: name.trim(),
            transport: 'stdio',
            command: command.trim().split(/\s+/)[0],
            args: command.trim().split(/\s+/).slice(1),
            env: envObj && Object.keys(envObj).length > 0 ? envObj : undefined,
          }
        : {
            name: name.trim(),
            transport: 'http',
            url: url.trim(),
            ...(authConfig ? { auth: authConfig } : {}),
          };

      if (agentId) {
        const { data } = await db
          .from('agent_workforce_agents')
          .select('config')
          .eq('id', agentId)
          .single();

        const agentConfig = data
          ? (typeof (data as { config: unknown }).config === 'string'
              ? JSON.parse((data as { config: string }).config)
              : ((data as { config: Record<string, unknown> }).config || {}))
          : {};

        const existing = (agentConfig.mcp_servers as McpServerConfig[]) || [];
        agentConfig.mcp_servers = [...existing, newServer];

        await db.from('agent_workforce_agents').update({
          config: JSON.stringify(agentConfig),
          updated_at: new Date().toISOString(),
        }).eq('id', agentId);
      } else {
        const { data: existing } = await db
          .from('runtime_settings')
          .select('value')
          .eq('key', 'global_mcp_servers')
          .maybeSingle();

        let current: McpServerConfig[] = [];
        if (existing) {
          try { current = JSON.parse((existing as { value: string }).value) as McpServerConfig[]; } catch { current = []; }
        }
        current.push(newServer);

        const { data: row } = await db.from('runtime_settings').select('key').eq('key', 'global_mcp_servers').maybeSingle();
        if (row) {
          await db.from('runtime_settings').update({ value: JSON.stringify(current), updated_at: new Date().toISOString() }).eq('key', 'global_mcp_servers');
        } else {
          await db.from('runtime_settings').insert({ key: 'global_mcp_servers', value: JSON.stringify(current) });
        }
      }

      // Move to the test step
      nextStep();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn\'t save. Try again?');
    } finally {
      setSaving(false);
    }
  };

  useInput((_input, key) => {
    if (key.escape) { onCancel(); return; }
  });

  const progressDots = steps.map((_, i) => (
    <Text key={i} color={i === stepIndex ? 'cyan' : i < stepIndex ? 'green' : 'gray'}>
      {i === stepIndex ? '◉ ' : i < stepIndex ? '● ' : '○ '}
    </Text>
  ));

  // Current env var being prompted (for catalog flow)
  const currentEnvVar = catalogEntry?.envVarsRequired[currentEnvIndex];
  const currentEnvValue = currentEnvVar ? (catalogEnvValues[currentEnvVar.key] || '') : '';

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">Add MCP Server  </Text>
        {progressDots}
      </Box>

      {step === 'source' && (
        <Box flexDirection="column">
          <Text>How would you like to add a server?</Text>
          <SelectInput
            items={SOURCE_OPTIONS}
            onSelect={item => {
              if (item.value === 'catalog') {
                goToStep('catalog');
              } else {
                setFromCatalog(false);
                setCatalogEntry(null);
                goToStep('transport');
              }
            }}
          />
        </Box>
      )}

      {step === 'catalog' && (
        <Box flexDirection="column">
          <Text bold>Select a server</Text>
          <Box marginTop={1}>
            <ScrollableList
              items={CATALOG_ITEMS}
              maxVisible={10}
              onSelect={handleCatalogSelect}
              renderItem={(item, _index, isSelected) => {
                const e = item.entry;
                const catLabel = CATALOG_CATEGORIES.find(c => c.id === e.category)?.label || e.category;
                return (
                  <Box>
                    <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                      {e.name}
                    </Text>
                    <Text color="gray"> </Text>
                    <Text color={isSelected ? 'gray' : 'gray'} dimColor={!isSelected}>
                      {e.description}
                    </Text>
                    <Text color="magenta" dimColor> [{catLabel}]</Text>
                  </Box>
                );
              }}
            />
          </Box>
        </Box>
      )}

      {step === 'transport' && (
        <Box flexDirection="column">
          <Text>Transport</Text>
          <SelectInput
            items={TRANSPORT_OPTIONS}
            onSelect={item => {
              setTransport(item.value as 'stdio' | 'http');
              nextStep();
            }}
          />
        </Box>
      )}

      {step === 'name' && (
        <InputField
          label="Name (used as tool prefix)"
          value={name}
          onChange={setName}
          onSubmit={() => {
            if (!name.trim()) { setError('Name is required'); return; }
            nextStep();
          }}
        />
      )}

      {step === 'endpoint' && transport === 'stdio' && (
        <InputField
          label="Command + args (e.g. npx -y @mcp/server-fs /tmp)"
          value={command}
          onChange={setCommand}
          onSubmit={() => {
            if (!command.trim()) { setError('Command is required'); return; }
            nextStep();
          }}
        />
      )}

      {step === 'endpoint' && transport === 'http' && (
        <InputField
          label="URL (e.g. http://localhost:5173/sse)"
          value={url}
          onChange={setUrl}
          onSubmit={() => {
            if (!url.trim()) { setError('URL is required'); return; }
            nextStep();
          }}
        />
      )}

      {step === 'env' && fromCatalog && currentEnvVar && (
        <InputField
          label={currentEnvVar.label}
          value={currentEnvValue}
          onChange={val => setCatalogEnvValues(prev => ({ ...prev, [currentEnvVar.key]: val }))}
          onSubmit={() => {
            if (currentEnvIndex < (catalogEntry?.envVarsRequired.length ?? 1) - 1) {
              setCurrentEnvIndex(i => i + 1);
            } else {
              nextStep();
            }
          }}
        />
      )}

      {step === 'env' && !fromCatalog && transport === 'stdio' && (
        <InputField
          label="Env vars (optional, KEY=VALUE,KEY2=VALUE2)"
          value={envRaw}
          onChange={setEnvRaw}
          onSubmit={nextStep}
        />
      )}

      {step === 'auth' && transport === 'http' && (
        <Box flexDirection="column">
          <Text>Authentication</Text>
          <SelectInput
            items={[
              { label: 'None', value: 'none' },
              { label: 'Bearer token', value: 'bearer' },
              { label: 'API key', value: 'api_key' },
            ]}
            onSelect={item => {
              const val = item.value as 'none' | 'bearer' | 'api_key';
              setAuthType(val);
              if (val === 'none') nextStep();
            }}
          />
          {authType === 'bearer' && (
            <InputField
              label="Bearer token"
              value={authToken}
              onChange={setAuthToken}
              onSubmit={() => {
                if (!authToken.trim()) { setError('Token is required'); return; }
                nextStep();
              }}
            />
          )}
          {authType === 'api_key' && (
            <InputField
              label="API key"
              value={authKey}
              onChange={setAuthKey}
              onSubmit={() => {
                if (!authKey.trim()) { setError('API key is required'); return; }
                nextStep();
              }}
            />
          )}
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column">
          <Text bold>Summary</Text>
          <Text>  Name:      <Text color="cyan">{name || '(not set)'}</Text></Text>
          <Text>  Transport: <Text color="cyan">{transport}</Text></Text>
          {transport === 'stdio' && <Text>  Command:   <Text color="cyan">{command || '(not set)'}</Text></Text>}
          {transport === 'http' && <Text>  URL:       <Text color="cyan">{url || '(not set)'}</Text></Text>}
          {fromCatalog && catalogEntry && catalogEntry.envVarsRequired.length > 0 && (
            <Box flexDirection="column">
              {catalogEntry.envVarsRequired.map(v => (
                <Text key={v.key}>  {v.label}: <Text color="cyan">{catalogEnvValues[v.key] || '(not set)'}</Text></Text>
              ))}
            </Box>
          )}
          {transport === 'http' && authType !== 'none' && (
            <Text>  Auth:      <Text color="cyan">{authType === 'bearer' ? 'Bearer token' : 'API key'}</Text></Text>
          )}
          {!fromCatalog && envRaw && <Text>  Env:       <Text color="cyan">{envRaw}</Text></Text>}
          {error && <Text color="red">{error}</Text>}
          <Box marginTop={1}>
            <Text color="gray">{saving ? 'Saving...' : 'Press Enter to save'}</Text>
          </Box>
        </Box>
      )}

      {step === 'test' && (
        <TestStep
          transport={transport}
          serverName={name}
          command={command}
          url={url}
          envRaw={envRaw}
          fromCatalog={fromCatalog}
          catalogEntry={catalogEntry}
          catalogEnvValues={catalogEnvValues}
          authType={authType}
          authToken={authToken}
          authKey={authKey}
          testing={testing}
          setTesting={setTesting}
          testResult={testResult}
          setTestResult={setTestResult}
          onComplete={onComplete}
        />
      )}

      {error && step !== 'confirm' && step !== 'test' && <Text color="red">{error}</Text>}

      <KeyHints hints={[
        ...(stepIndex > 0 && step !== 'test' ? [{ key: '←', label: 'back' }] : []),
        { key: 'Esc', label: 'cancel' },
        ...(step === 'confirm' ? [{ key: 'Enter', label: 'save' }] : []),
        ...(step === 'test' && !testing ? [{ key: 'Enter', label: 'finish' }] : []),
      ]} />

      {step === 'confirm' && !saving && (
        <Box>
          <ConfirmCapture onConfirm={save} onBack={prevStep} />
        </Box>
      )}
    </Box>
  );
}

/** Test step: connects to the server, discovers tools, shows results. */
function TestStep({
  transport, serverName, command, url, envRaw,
  fromCatalog, catalogEntry, catalogEnvValues,
  authType, authToken, authKey,
  testing, setTesting, testResult, setTestResult, onComplete,
}: {
  transport: 'stdio' | 'http';
  serverName: string;
  command: string;
  url: string;
  envRaw: string;
  fromCatalog: boolean;
  catalogEntry: McpCatalogEntry | null;
  catalogEnvValues: Record<string, string>;
  authType: 'none' | 'bearer' | 'api_key';
  authToken: string;
  authKey: string;
  testing: boolean;
  setTesting: (v: boolean) => void;
  testResult: McpTestResult | null;
  setTestResult: (v: McpTestResult) => void;
  onComplete: () => void;
}) {
  useEffect(() => {
    if (testing || testResult) return;

    const authConfig: McpAuthConfig | undefined =
      transport === 'http' && authType === 'bearer' && authToken.trim()
        ? { type: 'bearer', token: authToken.trim() }
        : transport === 'http' && authType === 'api_key' && authKey.trim()
          ? { type: 'api_key', key: authKey.trim() }
          : undefined;

    const envObj = fromCatalog && catalogEntry && catalogEntry.envVarsRequired.length > 0
      ? catalogEnvValues
      : (envRaw.trim() ? parseEnv(envRaw) : undefined);

    const serverConfig: McpServerConfig = transport === 'stdio'
      ? {
          name: serverName.trim(),
          transport: 'stdio',
          command: command.trim().split(/\s+/)[0],
          args: command.trim().split(/\s+/).slice(1),
          env: envObj && Object.keys(envObj).length > 0 ? envObj : undefined,
        }
      : {
          name: serverName.trim(),
          transport: 'http',
          url: url.trim(),
          ...(authConfig ? { auth: authConfig } : {}),
        };

    setTesting(true);
    testMcpConnection(serverConfig).then(result => {
      setTestResult(result);
      setTesting(false);
    });
  }, [testing, testResult, transport, serverName, command, url, envRaw, fromCatalog, catalogEntry, catalogEnvValues, authType, authToken, authKey, setTesting, setTestResult]);

  useInput((_input, key) => {
    if (key.return && !testing) {
      onComplete();
    }
  });

  return (
    <Box flexDirection="column">
      {testing && (
        <Text color="yellow">Testing connection...</Text>
      )}
      {testResult && testResult.success && (
        <Box flexDirection="column">
          <Text color="green">Connected. {testResult.tools.length === 1 ? '1 tool' : `${testResult.tools.length} tools`} found in {testResult.latencyMs}ms</Text>
          {testResult.tools.map(t => (
            <Text key={t.name} color="green">  - {t.name}</Text>
          ))}
        </Box>
      )}
      {testResult && !testResult.success && (
        <Box flexDirection="column">
          <Text color="yellow">Couldn&apos;t connect: {testResult.error}</Text>
          <Text color="gray">The server was saved. You can test again later.</Text>
        </Box>
      )}
      {!testing && (
        <Box marginTop={1}>
          <Text color="gray">Press Enter to finish</Text>
        </Box>
      )}
    </Box>
  );
}

/** Tiny helper that captures Enter/left-arrow in confirm step without disrupting other inputs. */
function ConfirmCapture({ onConfirm, onBack }: { onConfirm: () => void; onBack: () => void }) {
  useInput((_input, key) => {
    if (key.return) { onConfirm(); return; }
    if (key.leftArrow) { onBack(); return; }
  });
  return null;
}

function parseEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return result;
}
