/**
 * Onboarding Page
 * 7-screen onboarding flow with business profiling and agent discovery.
 */

import { useEffect } from 'react';
import { useOnboarding } from '../hooks/useOnboarding';
import { setToken } from '../api/client';
import { SplashScreen } from './onboarding/SplashScreen';
import { ModelScreen } from './onboarding/ModelScreen';
import { BusinessInfoScreen } from './onboarding/BusinessInfoScreen';
import { FounderStageScreen } from './onboarding/FounderStageScreen';
import { AgentDiscoveryScreen } from './onboarding/AgentDiscoveryScreen';
import { AgentSelectionScreen } from './onboarding/AgentSelectionScreen';
import { ReadyScreen } from './onboarding/ReadyScreen';

interface OnboardingPageProps {
  sessionToken?: string;
}

export function OnboardingPage({ sessionToken }: OnboardingPageProps) {
  const onboarding = useOnboarding();

  // Pre-fetch status when entering model screen
  useEffect(() => {
    if (onboarding.screen === 'model' && !onboarding.status) {
      onboarding.fetchStatus();
    }
  }, [onboarding.screen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLaunch = async () => {
    const err = await onboarding.completeOnboarding();
    if (!err) {
      if (sessionToken) {
        setToken(sessionToken);
      }
      window.location.href = '/ui/chat';
    }
  };

  switch (onboarding.screen) {
    case 'splash':
      return <SplashScreen onGetStarted={onboarding.goToModel} />;

    case 'model':
      return (
        <ModelScreen
          status={onboarding.status}
          selectedModel={onboarding.selectedModel}
          loading={onboarding.loading}
          downloading={onboarding.downloading}
          downloadPercent={onboarding.downloadPercent}
          downloadMessage={onboarding.downloadMessage}
          setupMessage={onboarding.setupMessage}
          error={onboarding.error}
          estimatedMinutes={onboarding.status?.estimatedMinutes ?? null}
          onSelectModel={onboarding.selectModel}
          onDownload={onboarding.startDownload}
          onSkip={onboarding.skipDownload}
        />
      );

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
          onBack={onboarding.goToModel}
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
          onContinue={onboarding.goToReady}
          onBack={onboarding.goToAgentDiscovery}
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
        />
      );
  }
}
