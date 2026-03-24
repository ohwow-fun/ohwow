import { useState, useCallback, useEffect, useRef } from 'react';
import { CircleNotch } from '@phosphor-icons/react';
import { api } from '../../api/client';

interface VoiceProfile {
  id: string;
  name: string;
  language?: string;
}

interface VoiceProvidersData {
  voiceboxAvailable: boolean;
}

export function VoiceSection() {
  const [voiceProviders, setVoiceProviders] = useState<VoiceProvidersData | null>(null);
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [orchestratorVoice, setOrchestratorVoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [enablingVoicebox, setEnablingVoicebox] = useState(false);

  const fetchVoiceProviders = useCallback(async () => {
    try {
      const res = await api<{ data: VoiceProvidersData }>('/api/voice/providers');
      setVoiceProviders(res.data);

      if (res.data.voiceboxAvailable) {
        const [profilesRes, settingRes] = await Promise.all([
          api<{ data: VoiceProfile[] }>('/api/voice/profiles'),
          api<{ data: { key: string; value: string } | null }>('/api/settings/orchestrator_voice_profile_id'),
        ]);
        setProfiles(profilesRes.data || []);
        setOrchestratorVoice(settingRes.data?.value || '');
      }
    } catch {
      setVoiceProviders(null);
    }
  }, []);

  const voiceLoadedRef = useRef(false);

  // Update ref when voicebox becomes available
  useEffect(() => {
    if (voiceProviders?.voiceboxAvailable) {
      voiceLoadedRef.current = true;
    }
  }, [voiceProviders?.voiceboxAvailable]);

  useEffect(() => {
    let cancelled = false;
    let pollInterval: ReturnType<typeof setInterval> | undefined;

    const init = async () => {
      await fetchVoiceProviders();

      // Poll every 10s until voicebox is detected
      if (!cancelled && !voiceLoadedRef.current) {
        pollInterval = setInterval(async () => {
          if (cancelled || voiceLoadedRef.current) {
            if (pollInterval) clearInterval(pollInterval);
            return;
          }
          await fetchVoiceProviders();
        }, 10000);
      }
    };

    init();
    return () => {
      cancelled = true;
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [fetchVoiceProviders]);

  const handleEnableVoicebox = useCallback(async () => {
    setEnablingVoicebox(true);
    try {
      await api('/api/voice/enable', { method: 'POST' });
      await fetchVoiceProviders();
    } catch {
      // Voicebox start failed
    } finally {
      setEnablingVoicebox(false);
    }
  }, [fetchVoiceProviders]);

  const handleVoiceChange = useCallback(async (profileId: string) => {
    setSaving(true);
    setOrchestratorVoice(profileId);
    try {
      await api('/api/settings/orchestrator_voice_profile_id', {
        method: 'PUT',
        body: JSON.stringify({ value: profileId }),
      });
    } catch {
      setOrchestratorVoice('');
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <div className="mb-6">
      <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Voice</h2>
      <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
        {voiceProviders && (
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full ${voiceProviders.voiceboxAvailable ? 'bg-success' : 'bg-white/10'}`} />
              <span className={voiceProviders.voiceboxAvailable ? '' : 'text-neutral-400'}>
                {voiceProviders.voiceboxAvailable ? 'Voicebox is running' : 'Voicebox is not running'}
              </span>
            </div>
          </div>
        )}

        {voiceProviders && !voiceProviders.voiceboxAvailable && (
          <div className="px-4 py-3">
            <button
              onClick={handleEnableVoicebox}
              disabled={enablingVoicebox}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/5 border border-white/10 text-white rounded-lg hover:bg-white/10 disabled:opacity-50 transition-colors"
            >
              {enablingVoicebox ? (
                <><CircleNotch size={14} className="animate-spin" /> Starting Voicebox...</>
              ) : (
                'Enable Voicebox'
              )}
            </button>
            <p className="text-xs text-neutral-400 mt-1.5">
              Local speech-to-text and text-to-speech using Whisper and Coqui TTS.
            </p>
          </div>
        )}

        {voiceProviders?.voiceboxAvailable && (
          <div className="px-4 py-3">
            <label className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Orchestrator voice</p>
                <p className="text-xs text-neutral-400">Voice used when chatting from the main conversation</p>
              </div>
              <select
                value={orchestratorVoice}
                onChange={e => handleVoiceChange(e.target.value)}
                disabled={saving}
                className="bg-black border border-white/[0.08] rounded-md px-3 py-1.5 text-sm min-w-[180px]"
              >
                <option value="">Default voice</option>
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          </div>
        )}

      </div>
    </div>
  );
}
