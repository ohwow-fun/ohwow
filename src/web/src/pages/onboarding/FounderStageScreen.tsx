/**
 * Onboarding Screen 4: Founder Stage
 * Path selection cards + focus text input.
 */

const FOUNDER_PATHS = [
  { id: 'exploring', label: 'Exploring ideas', description: 'Still figuring out what to build', icon: '🔍' },
  { id: 'just_starting', label: 'Just starting', description: 'Building the first version', icon: '🚀' },
  { id: 'no_revenue', label: 'Pre-revenue', description: 'Launched but not making money yet', icon: '📈' },
  { id: 'making_money', label: 'Making money', description: 'Revenue is coming in', icon: '💰' },
];

interface FounderStageScreenProps {
  founderPath: string;
  founderFocus: string;
  onChangePath: (value: string) => void;
  onChangeFocus: (value: string) => void;
  onContinue: () => void;
  onBack: () => void;
}

export function FounderStageScreen({
  founderPath,
  founderFocus,
  onChangePath,
  onChangeFocus,
  onContinue,
  onBack,
}: FounderStageScreenProps) {
  const canContinue = founderPath.length > 0;

  return (
    <div data-testid="onboarding-founder-stage" className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      <div className="max-w-lg w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <p className="text-xs text-neutral-400 uppercase tracking-wider">Step 4 of 7</p>
          <h2 className="text-2xl font-bold text-white">Where are you in your journey?</h2>
          <p className="text-sm text-neutral-400">This helps us prioritize which agents to recommend.</p>
        </div>

        {/* Path Selection */}
        <div className="space-y-2">
          {FOUNDER_PATHS.map(fp => (
            <button
              key={fp.id}
              data-testid={`onboarding-path-${fp.id}`}
              onClick={() => onChangePath(fp.id)}
              className={`w-full text-left px-4 py-3 rounded-lg border transition-colors flex items-center gap-3 ${
                founderPath === fp.id
                  ? 'border-white/20 bg-white/10 text-white'
                  : 'border-white/[0.08] bg-white/5 text-neutral-400 hover:border-white/20 hover:text-white'
              }`}
            >
              <span className="text-lg">{fp.icon}</span>
              <div>
                <span className="font-medium block text-sm">{fp.label}</span>
                <span className="text-xs text-neutral-400">{fp.description}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Focus Input */}
        <div>
          <label className="block text-sm text-neutral-400 mb-1.5">What are you focused on right now? (optional)</label>
          <input
            data-testid="onboarding-founder-focus"
            type="text"
            value={founderFocus}
            onChange={e => onChangeFocus(e.target.value)}
            placeholder="e.g. Getting my first 10 customers"
            className="w-full bg-white/5 border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white placeholder:text-neutral-400/50 focus:outline-none focus:border-white/20"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onBack}
            className="px-4 py-2.5 text-sm text-neutral-400 hover:text-white transition-colors"
          >
            Back
          </button>
          <button
            data-testid="onboarding-founder-continue"
            onClick={onContinue}
            disabled={!canContinue}
            className="flex-1 bg-white text-black rounded-lg px-6 py-2.5 text-sm font-medium hover:bg-neutral-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
