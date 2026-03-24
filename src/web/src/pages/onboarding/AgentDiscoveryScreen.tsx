/**
 * Onboarding Screen 5: Agent Discovery
 * AI chat interface (SSE) or preset browser (fallback when no model).
 */

import { useState, useRef, useEffect } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentPreset {
  id: string;
  name: string;
  role: string;
  description: string;
  recommended?: boolean;
}

interface AgentDiscoveryScreenProps {
  modelAvailable: boolean;
  businessType: string;
  founderPath: string;
  founderFocus: string;
  chatMessages: ChatMessage[];
  presets: AgentPreset[];
  onSendMessage: (message: string) => void;
  onContinue: () => void;
  onBack: () => void;
  streaming: boolean;
}

export function AgentDiscoveryScreen({
  modelAvailable,
  chatMessages,
  presets,
  onSendMessage,
  onContinue,
  onBack,
  streaming,
}: AgentDiscoveryScreenProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chatMessages]);

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    onSendMessage(input.trim());
    setInput('');
  };

  if (!modelAvailable) {
    // Fallback: show preset recommendations
    return (
      <div data-testid="onboarding-agent-discovery" className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
        <div className="max-w-lg w-full space-y-6">
          <div className="text-center space-y-2">
            <p className="text-xs text-neutral-400 uppercase tracking-wider">Step 5 of 7</p>
            <h2 className="text-2xl font-bold text-white">Your recommended agents</h2>
            <p className="text-sm text-neutral-400">Based on your business type. You can adjust on the next screen.</p>
          </div>

          <div className="space-y-2">
            {presets.map(agent => (
              <div
                key={agent.id}
                className={`px-4 py-3 rounded-lg border ${
                  agent.recommended ? 'border-white/[0.12] bg-white/5' : 'border-white/[0.08] bg-white/5'
                }`}
              >
                <div className="flex items-center gap-2">
                  {agent.recommended && <span className="text-white text-xs">★</span>}
                  <span className="font-medium text-sm text-white">{agent.name}</span>
                  <span className="text-xs text-neutral-400">{agent.role}</span>
                </div>
                <p className="text-xs text-neutral-400 mt-1">{agent.description}</p>
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <button onClick={onBack} className="px-4 py-2.5 text-sm text-neutral-400 hover:text-white transition-colors">
              Back
            </button>
            <button
              data-testid="onboarding-discovery-continue"
              onClick={onContinue}
              className="flex-1 bg-white text-black rounded-lg px-6 py-2.5 text-sm font-medium hover:bg-neutral-200 transition-colors"
            >
              Continue to selection
            </button>
          </div>
        </div>
      </div>
    );
  }

  // AI chat mode
  return (
    <div data-testid="onboarding-agent-discovery" className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      <div className="max-w-lg w-full space-y-6">
        <div className="text-center space-y-2">
          <p className="text-xs text-neutral-400 uppercase tracking-wider">Step 5 of 7</p>
          <h2 className="text-2xl font-bold text-white">Meet your AI advisor</h2>
          <p className="text-sm text-neutral-400">Chat to get personalized agent recommendations.</p>
        </div>

        {/* Chat area */}
        <div
          ref={scrollRef}
          className="bg-white/5 border border-white/[0.08] rounded-lg p-4 space-y-3 max-h-64 overflow-y-auto"
        >
          {chatMessages.map((msg, i) => (
            <div key={i} className={`${msg.role === 'user' ? 'text-right' : ''}`}>
              <div
                className={`inline-block rounded-lg px-3 py-2 text-sm max-w-[80%] ${
                  msg.role === 'user'
                    ? 'bg-white/10 text-white'
                    : 'bg-neutral-950 border border-white/[0.08] text-white'
                }`}
              >
                <pre className="whitespace-pre-wrap break-words font-sans">{msg.content}</pre>
              </div>
            </div>
          ))}
          {streaming && (
            <div className="text-neutral-400 text-sm animate-pulse">Thinking...</div>
          )}
        </div>

        {/* Input */}
        <div className="flex gap-2">
          <input
            data-testid="onboarding-chat-input"
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
            placeholder="Tell the AI about your priorities..."
            disabled={streaming}
            className="flex-1 bg-white/5 border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white placeholder:text-neutral-400/50 focus:outline-none focus:border-white/20 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={streaming || !input.trim()}
            className="bg-white text-black rounded-lg px-4 text-sm hover:bg-neutral-200 transition-colors disabled:opacity-40"
          >
            Send
          </button>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button onClick={onBack} className="px-4 py-2.5 text-sm text-neutral-400 hover:text-white transition-colors">
            Back
          </button>
          <button
            data-testid="onboarding-discovery-continue"
            onClick={onContinue}
            className="flex-1 bg-white text-black rounded-lg px-6 py-2.5 text-sm font-medium hover:bg-neutral-200 transition-colors"
          >
            {chatMessages.length >= 4 ? 'Continue to selection' : 'Skip to selection'}
          </button>
        </div>
      </div>
    </div>
  );
}
