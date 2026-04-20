/**
 * New Business Page
 * Reuses the onboarding state machine starting at business_info to create
 * a new ohwow workspace from the portfolio page.
 */

import { useNavigate } from 'react-router-dom';
import { useOnboarding } from '../hooks/useOnboarding';
import { BusinessInfoScreen } from './onboarding/BusinessInfoScreen';
import { FounderStageScreen } from './onboarding/FounderStageScreen';
import { AgentDiscoveryScreen } from './onboarding/AgentDiscoveryScreen';
import { AgentSelectionScreen } from './onboarding/AgentSelectionScreen';
import { IntegrationSetupScreen } from './onboarding/IntegrationSetupScreen';
import { ReadyScreen } from './onboarding/ReadyScreen';

export function NewBusinessPage() {
  const navigate = useNavigate();
  const onboarding = useOnboarding({
    mode: 'new-workspace',
    onWorkspaceCreated: () => navigate('/portfolio'),
  });

  const handleLaunch = async () => {
    await onboarding.completeOnboarding();
  };

  switch (onboarding.screen) {
    case 'business_info':
      return (
        <BusinessInfoScreen
          businessName={onboarding.businessName}
          businessType={onboarding.businessType}
          businessDescription={onboarding.businessDescription}
          onChangeName={onboarding.setBusinessName}
          onChangeType={onboarding.setBusinessType}
          onChangeDescription={onboarding.setBusinessDescription}
          onContinue={onboarding.goToFounderStage}
          onBack={() => navigate('/portfolio')}
        />
      );

    case 'founder_stage':
      return (
        <FounderStageScreen
          founderPath={onboarding.founderPath}
          founderFocus={onboarding.founderFocus}
          onChangePath={onboarding.setFounderPath}
          onChangeFocus={onboarding.setFounderFocus}
          onContinue={onboarding.goToAgentDiscovery}
          onBack={onboarding.goToBusinessInfo}
        />
      );

    case 'agent_discovery':
      return (
        <AgentDiscoveryScreen
          modelAvailable={onboarding.modelAvailable}
          businessType={onboarding.businessType}
          founderPath={onboarding.founderPath}
          founderFocus={onboarding.founderFocus}
          chatMessages={onboarding.chatMessages}
          presets={onboarding.presets}
          discoveredGoal={onboarding.discoveredGoal}
          onSendMessage={onboarding.sendChatMessage}
          onContinue={onboarding.goToAgentSelection}
          onBack={onboarding.goToFounderStage}
          streaming={onboarding.chatStreaming}
        />
      );

    case 'agent_selection':
      return (
        <AgentSelectionScreen
          presets={onboarding.presets}
          selectedIds={onboarding.selectedAgentIds}
          onToggle={onboarding.toggleAgent}
          onContinue={onboarding.goToIntegrationSetup}
          onBack={onboarding.goToAgentDiscovery}
        />
      );

    case 'integration_setup':
      return (
        <IntegrationSetupScreen
          integrations={onboarding.integrations}
          integrationValues={onboarding.integrationValues}
          onSetValue={onboarding.setIntegrationValue}
          onSkipIntegration={onboarding.skipIntegration}
          skippedIds={onboarding.skippedIntegrationIds}
          onContinue={onboarding.goToReady}
          onBack={onboarding.goToAgentSelection}
        />
      );

    case 'ready':
      return (
        <ReadyScreen
          selectedModel={onboarding.selectedModel}
          loading={onboarding.loading}
          error={onboarding.error}
          onLaunch={handleLaunch}
          businessName={onboarding.businessName}
          agentCount={onboarding.selectedAgentIds.size}
          launchLabel="Create Business"
        />
      );

    default:
      return null;
  }
}
