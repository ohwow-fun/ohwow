/**
 * VoiceCallControls (Runtime Web UI)
 * Mute and end call buttons for active voice sessions.
 */

import { Microphone, MicrophoneSlash, PhoneDisconnect } from '@phosphor-icons/react';

interface VoiceCallControlsProps {
  isMuted: boolean;
  onToggleMute: () => void;
  onEndCall: () => void;
}

export function VoiceCallControls({ isMuted, onToggleMute, onEndCall }: VoiceCallControlsProps) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onToggleMute}
        className={`p-3 rounded-full transition-all duration-150 active:scale-95 ${
          isMuted
            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
            : 'bg-white/[0.08] text-neutral-300 hover:bg-white/[0.12] hover:text-white'
        }`}
        title={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? <MicrophoneSlash size={20} weight="fill" /> : <Microphone size={20} weight="fill" />}
      </button>

      <button
        onClick={onEndCall}
        className="p-3 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 hover:text-red-300 active:scale-95 transition-all duration-150"
        title="End call"
      >
        <PhoneDisconnect size={20} weight="fill" />
      </button>
    </div>
  );
}
