/**
 * License Key Setup Wizard
 * Simple 2-step flow: enter key → done.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { InputField } from '../components/input-field.js';
import { KeyHints } from '../components/key-hints.js';
import { updateConfigFile } from '../../config.js';

type WizardStep = 'input' | 'done';

interface LicenseKeyWizardProps {
  onComplete: (licenseKey: string) => void;
  onCancel: () => void;
}

export function LicenseKeyWizard({ onComplete, onCancel }: LicenseKeyWizardProps) {
  const [step, setStep] = useState<WizardStep>('input');
  const [licenseKey, setLicenseKey] = useState('');

  const handleSubmit = () => {
    const trimmed = licenseKey.trim();
    if (!trimmed) return;
    updateConfigFile({ licenseKey: trimmed, tier: 'connected' });
    setStep('done');
  };

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (step === 'done' && key.return) {
      onComplete(licenseKey.trim());
    }
  });

  const steps: WizardStep[] = ['input', 'done'];
  const stepIdx = steps.indexOf(step);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">License Key Setup</Text>
        <Text color="gray"> | Step {stepIdx + 1} of {steps.length}</Text>
      </Box>

      {/* Progress dots */}
      <Box marginBottom={1}>
        {steps.map((s, i) => (
          <Text key={s} color={i < stepIdx ? 'green' : i === stepIdx ? 'cyan' : 'gray'}>
            {i < stepIdx ? '●' : i === stepIdx ? '◉' : '○'}{' '}
          </Text>
        ))}
      </Box>

      {/* Step: input */}
      {step === 'input' && (
        <Box flexDirection="column">
          <Text bold>Enter your license key</Text>
          <Box marginTop={1}>
            <Text color="gray">
              Paste the key you received after purchasing at <Text color="cyan" bold>ohwow.fun</Text>.
            </Text>
          </Box>
          <Box marginTop={1}>
            <InputField
              label="License key"
              value={licenseKey}
              onChange={setLicenseKey}
              onSubmit={handleSubmit}
              mask="*"
              placeholder="paste your key here"
            />
          </Box>
        </Box>
      )}

      {/* Step: done */}
      {step === 'done' && (
        <Box flexDirection="column">
          <Text bold color="green">License key activated!</Text>
          <Box marginTop={1}>
            <Text color="gray">Your runtime is now connected to ohwow.fun cloud.</Text>
          </Box>
        </Box>
      )}

      {/* Key hints */}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Esc', label: 'Cancel' },
            ...(step === 'input' ? [{ key: 'Enter', label: 'Save' }] : []),
            ...(step === 'done' ? [{ key: 'Enter', label: 'Done' }] : []),
          ]}
        />
      </Box>
    </Box>
  );
}
