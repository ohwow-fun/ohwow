/**
 * GestureFeedback
 * HUD overlay showing current detected gesture and action confirmations.
 * Positioned in the top-right area, overlays the eye page.
 */

import { useState, useEffect } from 'react';
import {
  Hand,
  HandFist,
  ThumbsUp,
  ThumbsDown,
  Microphone,
  MicrophoneSlash,
  Heart,
  HandPalm,
} from '@phosphor-icons/react';

// ============================================================================
// TYPES
// ============================================================================

export interface GestureAction {
  type: string;
  ts: number;
}

interface GestureFeedbackProps {
  /** Currently detected gesture name, or null */
  gesture: string | null;
  /** Last triggered action, or null */
  action: GestureAction | null;
}

// ============================================================================
// GESTURE DISPLAY CONFIG
// ============================================================================

const GESTURE_DISPLAY: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  Open_Palm: {
    label: 'Open Palm',
    icon: <HandPalm size={14} weight="fill" />,
    color: 'text-cyan-400',
  },
  Closed_Fist: {
    label: 'Fist',
    icon: <HandFist size={14} weight="fill" />,
    color: 'text-neutral-400',
  },
  Pointing_Up: {
    label: 'Raise Hand',
    icon: <Hand size={14} weight="fill" />,
    color: 'text-amber-400',
  },
  Thumb_Up: {
    label: 'Thumbs Up',
    icon: <ThumbsUp size={14} weight="fill" />,
    color: 'text-green-400',
  },
  Thumb_Down: {
    label: 'Thumbs Down',
    icon: <ThumbsDown size={14} weight="fill" />,
    color: 'text-red-400',
  },
  Victory: {
    label: 'Peace',
    icon: <Hand size={14} weight="fill" />,
    color: 'text-violet-400',
  },
  ILoveYou: {
    label: 'Love',
    icon: <Heart size={14} weight="fill" />,
    color: 'text-pink-400',
  },
};

const ACTION_DISPLAY: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  mute: {
    icon: <MicrophoneSlash size={32} weight="fill" />,
    color: 'text-red-400',
    bg: 'bg-red-500/10',
  },
  unmute: {
    icon: <Microphone size={32} weight="fill" />,
    color: 'text-green-400',
    bg: 'bg-green-500/10',
  },
  'thumbs-up': {
    icon: <ThumbsUp size={32} weight="fill" />,
    color: 'text-green-400',
    bg: 'bg-green-500/10',
  },
  'thumbs-down': {
    icon: <ThumbsDown size={32} weight="fill" />,
    color: 'text-red-400',
    bg: 'bg-red-500/10',
  },
  interrupt: {
    icon: <Hand size={32} weight="fill" />,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
  },
  peace: {
    icon: <Hand size={32} weight="fill" />,
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
  },
  love: {
    icon: <Heart size={32} weight="fill" />,
    color: 'text-pink-400',
    bg: 'bg-pink-500/10',
  },
};

// ============================================================================
// COMPONENT
// ============================================================================

export function GestureFeedback({ gesture, action }: GestureFeedbackProps) {
  const [displayAction, setDisplayAction] = useState<{ action: GestureAction; fading: boolean } | null>(null);

  // Show new action when prop changes (keyed on timestamp)
  useEffect(() => {
    if (!action) return;

    queueMicrotask(() => setDisplayAction({ action, fading: false }));

    const fadeTimer = setTimeout(() => {
      setDisplayAction(prev => prev ? { ...prev, fading: true } : null);
    }, 1000);
    const removeTimer = setTimeout(() => {
      setDisplayAction(null);
    }, 1500);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on action.ts to detect new actions
  }, [action?.ts]);

  const gestureInfo = gesture ? GESTURE_DISPLAY[gesture] : null;
  const actionInfo = displayAction ? ACTION_DISPLAY[displayAction.action.type] : null;

  return (
    <>
      {/* Current gesture badge — top right */}
      <div className="fixed top-16 right-4 z-20 flex flex-col items-end gap-2">
        {gestureInfo && (
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/40 backdrop-blur-sm border border-white/[0.08] transition-all duration-300 ${gestureInfo.color}`}
          >
            {gestureInfo.icon}
            <span className="text-[11px] font-medium">{gestureInfo.label}</span>
          </div>
        )}
      </div>

      {/* Action confirmation — centered */}
      {actionInfo && displayAction && (
        <div
          className={`fixed inset-0 z-30 flex items-center justify-center pointer-events-none transition-opacity duration-500 ${
            displayAction.fading ? 'opacity-0' : 'opacity-100'
          }`}
        >
          <div
            className={`flex flex-col items-center gap-2 p-6 rounded-3xl ${actionInfo.bg} backdrop-blur-sm border border-white/[0.06] gesture-pop`}
            style={{
              animation: displayAction.fading ? 'none' : 'gesture-pop 0.3s ease-out',
            }}
          >
            <div className={actionInfo.color}>
              {actionInfo.icon}
            </div>
            <span className={`text-xs font-medium ${actionInfo.color} opacity-70`}>
              {displayAction.action.type.replace('-', ' ')}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
