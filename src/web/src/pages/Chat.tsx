import { useState, useRef, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { PaperPlaneRight, Microphone, MicrophoneSlash, CaretDown, CaretRight, Plus, Wrench } from '@phosphor-icons/react';
import { streamChat, api } from '../api/client';
import { PageHeader } from '../components/PageHeader';
import { useVoiceChat } from '../hooks/useVoiceChat';
import { useTier } from '../hooks/useTier';
import { VoiceChatOverlay } from '../components/VoiceChatOverlay';

interface ToolCall {
  name: string;
  input?: Record<string, unknown>;
  output?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
}

function ToolCallChip({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white/[0.04] border border-white/[0.08] rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 py-1.5 text-xs text-neutral-300 hover:text-white transition-colors w-full text-left"
      >
        <Wrench size={14} className="text-neutral-400 shrink-0" />
        <span className="font-medium truncate">{toolCall.name}</span>
        {expanded ? <CaretDown size={12} className="ml-auto shrink-0" /> : <CaretRight size={12} className="ml-auto shrink-0" />}
      </button>
      {expanded && (
        <div className="border-t border-white/[0.06] px-3 py-2 space-y-2 text-xs">
          {toolCall.input && Object.keys(toolCall.input).length > 0 && (
            <div>
              <span className="text-neutral-500 block mb-1">Input</span>
              <pre className="text-neutral-300 whitespace-pre-wrap break-words font-mono text-[11px] bg-white/[0.03] rounded px-2 py-1.5">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.output && (
            <div>
              <span className="text-neutral-500 block mb-1">Output</span>
              <pre className="text-neutral-300 whitespace-pre-wrap break-words font-mono text-[11px] bg-white/[0.03] rounded px-2 py-1.5">
                {toolCall.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voiceChecked, setVoiceChecked] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { modelReady, loading: tierLoading } = useTier();

  // Model picker state
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [showModelPicker, setShowModelPicker] = useState(false);

  const voice = useVoiceChat('orchestrator');

  // Fetch available models
  useEffect(() => {
    api<{ data: { models: ModelInfo[]; currentModel: string } }>('/api/system/models')
      .then(res => {
        setModels(res.data.models);
        if (res.data.currentModel) {
          setSelectedModel(res.data.currentModel);
        }
      })
      .catch(() => {
        // Models endpoint not available
      });
  }, []);

  // Check if any voice provider is available, with periodic re-checks
  useEffect(() => {
    let cancelled = false;
    let stopPolling = false;

    const checkProviders = () => {
      fetch('/api/voice/providers')
        .then(res => res.json())
        .then(data => {
          if (cancelled) return;
          setVoiceChecked(true);
          const available = !!data?.data?.anyAvailable;
          setVoiceAvailable(available);
          if (available) stopPolling = true;
        })
        .catch(() => {
          // Voice providers not available
        });
    };

    checkProviders();
    // Re-check every 15 seconds until voice becomes available
    const intervalId = setInterval(() => {
      if (!cancelled && !stopPolling) checkProviders();
    }, 15000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  // Append voice transcriptions and responses to chat history
  const lastTranscriptRef = useRef('');
  const lastResponseRef = useRef('');

  useEffect(() => {
    if (voice.transcript && voice.transcript !== lastTranscriptRef.current) {
      lastTranscriptRef.current = voice.transcript;
      setMessages(prev => [...prev, { role: 'user', content: voice.transcript }]);
    }
  }, [voice.transcript]);

  useEffect(() => {
    if (voice.response && voice.response !== lastResponseRef.current) {
      lastResponseRef.current = voice.response;
      setMessages(prev => [...prev, { role: 'assistant', content: voice.response }]);
    }
  }, [voice.response]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setStreaming(true);

    let assistantContent = '';
    let toolCalls: ToolCall[] = [];
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const event of streamChat(text, sessionId, selectedModel || undefined)) {
        if (event.type === 'text') {
          assistantContent += event.content as string;
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: assistantContent, toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined };
            return updated;
          });
        } else if (event.type === 'tool_use' || event.type === 'tool_call') {
          const tc: ToolCall = {
            name: (event as Record<string, unknown>).name as string,
            input: (event as Record<string, unknown>).input as Record<string, unknown> | undefined,
          };
          toolCalls = [...toolCalls, tc];
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: assistantContent, toolCalls: [...toolCalls] };
            return updated;
          });
        } else if (event.type === 'tool_result') {
          if (toolCalls.length > 0) {
            toolCalls = [...toolCalls];
            toolCalls[toolCalls.length - 1] = {
              ...toolCalls[toolCalls.length - 1],
              output: (event as Record<string, unknown>).content as string | undefined,
            };
            setMessages(prev => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: assistantContent, toolCalls: [...toolCalls] };
              return updated;
            });
          }
        }
      }
    } catch {
      assistantContent += '\n\n[Connection lost. Try sending your message again.]';
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: assistantContent, toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined };
        return updated;
      });
    } finally {
      setStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewSession = () => {
    setSessionId(crypto.randomUUID());
    setMessages([]);
    lastTranscriptRef.current = '';
    lastResponseRef.current = '';
  };

  const handleSelectModel = (modelId: string) => {
    setSelectedModel(modelId);
    setShowModelPicker(false);
  };

  const currentModelName = models.find(m => m.id === selectedModel)?.name || selectedModel || 'Auto';

  const showMicButton = voiceAvailable && !input.trim() && !streaming;
  const showVoiceHint = voiceChecked && !voiceAvailable && !input.trim() && !streaming;

  // Show friendly empty state when no model is available
  if (!tierLoading && !modelReady && messages.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-6 pt-6 pb-0">
          <PageHeader title="Chat" subtitle="Talk to your orchestrator" />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3 max-w-sm">
            <p className="text-lg text-white font-medium">Your orchestrator needs a brain</p>
            <p className="text-sm text-neutral-400">
              Download an AI model to start chatting.
            </p>
            <NavLink
              to="/settings"
              className="inline-block bg-white text-black rounded-md px-4 py-2 text-sm font-medium hover:bg-neutral-200 transition-colors"
            >
              Go to Settings
            </NavLink>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-6 pt-6 pb-0 shrink-0">
        <PageHeader
          title="Chat"
          subtitle="Talk to your orchestrator"
          action={
            <div className="flex items-center gap-2">
              {/* Model picker */}
              <div className="relative">
                <button
                  onClick={() => setShowModelPicker(!showModelPicker)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-400 border border-white/10 rounded-lg hover:text-white hover:border-white/20 transition-colors"
                >
                  <span className="max-w-[120px] truncate">{currentModelName}</span>
                  <CaretDown size={12} />
                </button>
                {showModelPicker && models.length > 0 && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowModelPicker(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 bg-neutral-950 border border-white/10 rounded-lg py-1 min-w-[200px] shadow-lg">
                      {models.map(model => (
                        <button
                          key={model.id}
                          onClick={() => handleSelectModel(model.id)}
                          className={`w-full text-left px-3 py-2 text-xs hover:bg-white/[0.06] transition-colors ${
                            selectedModel === model.id ? 'text-white' : 'text-white'
                          }`}
                        >
                          <span className="block">{model.name}</span>
                          <span className="block text-neutral-400 text-[10px]">{model.provider}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* New session */}
              <button
                onClick={handleNewSession}
                disabled={streaming}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 text-white rounded-lg hover:bg-white/10 transition-colors disabled:opacity-50"
                title="New session"
              >
                <Plus size={14} /> New chat
              </button>
            </div>
          }
        />
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-neutral-400 text-sm">
            Ask your orchestrator anything about your agents, tasks, or business.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`max-w-2xl ${msg.role === 'user' ? 'ml-auto' : ''}`}
          >
            <div
              className={`px-4 py-3 text-sm ${
                msg.role === 'user'
                  ? 'bg-white/10 rounded-xl text-white'
                  : 'text-neutral-200'
              }`}
            >
              <pre className="whitespace-pre-wrap break-words font-sans">{msg.content || (streaming && i === messages.length - 1 ? '...' : '')}</pre>
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {msg.toolCalls.map((tc, j) => (
                    <ToolCallChip key={j} toolCall={tc} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="border-t border-white/[0.08] px-6 py-4 shrink-0">
        <div className="flex gap-2 max-w-2xl">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20 resize-none"
          />
          {showMicButton ? (
            <button
              onClick={() => voice.startCall()}
              className="bg-white/5 border border-white/10 text-white rounded-xl px-4 hover:bg-white/10 transition-colors"
              title="Start voice chat"
            >
              <Microphone size={18} />
            </button>
          ) : showVoiceHint ? (
            <div className="flex gap-2">
              <button
                disabled
                className="border border-white/10 text-neutral-500 rounded-xl px-4 cursor-not-allowed"
                title="Voice is available when Voicebox is running. Enable it in Settings."
              >
                <MicrophoneSlash size={18} />
              </button>
              <button
                onClick={handleSend}
                disabled={streaming || !input.trim()}
                className="bg-white text-black rounded-xl px-4 hover:bg-neutral-200 transition-colors disabled:opacity-50"
              >
                <PaperPlaneRight size={18} />
              </button>
            </div>
          ) : (
            <button
              onClick={handleSend}
              disabled={streaming || !input.trim()}
              className="bg-white text-black rounded-xl px-4 hover:bg-neutral-200 transition-colors disabled:opacity-50"
            >
              <PaperPlaneRight size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Voice overlay */}
      {voice.state !== 'idle' && (
        <VoiceChatOverlay
          state={voice.state}
          transcript={voice.transcript}
          response={voice.response}
          error={voice.error}
          isMuted={voice.isMuted}
          onToggleMute={voice.toggleMute}
          onEndCall={voice.endCall}
        />
      )}
    </div>
  );
}
