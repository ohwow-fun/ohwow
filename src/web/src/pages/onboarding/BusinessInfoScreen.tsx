/**
 * Onboarding Screen 3: Business Info
 * Collects business name, type (card selector), and description.
 */


const BUSINESS_TYPES = [
  { id: 'saas_startup', label: 'SaaS Startup', tagline: 'Ship faster with AI on your side' },
  { id: 'ecommerce', label: 'Ecommerce', tagline: 'Sell more with less effort' },
  { id: 'agency', label: 'Agency', tagline: 'Win more clients, deliver better work' },
  { id: 'content_creator', label: 'Content Creator', tagline: 'Create more, manage less' },
  { id: 'service_business', label: 'Service Business', tagline: 'Book more jobs, impress every client' },
  { id: 'consulting', label: 'Consulting', tagline: 'Land engagements, deliver excellence' },
];

interface BusinessInfoScreenProps {
  businessName: string;
  businessType: string;
  businessDescription: string;
  onChangeName: (value: string) => void;
  onChangeType: (value: string) => void;
  onChangeDescription: (value: string) => void;
  onContinue: () => void;
  onBack: () => void;
}

export function BusinessInfoScreen({
  businessName,
  businessType,
  businessDescription,
  onChangeName,
  onChangeType,
  onChangeDescription,
  onContinue,
  onBack,
}: BusinessInfoScreenProps) {
  const canContinue = businessName.trim().length > 0 && businessType;

  return (
    <div data-testid="onboarding-business-info" className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      <div className="max-w-lg w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <p className="text-xs text-neutral-400 uppercase tracking-wider">Step 3 of 7</p>
          <h2 className="text-2xl font-bold text-white">Tell us about your business</h2>
          <p className="text-sm text-neutral-400">This helps us recommend the right AI agents for you.</p>
        </div>

        {/* Business Name */}
        <div>
          <label className="block text-sm text-neutral-400 mb-1.5">Business name</label>
          <input
            data-testid="onboarding-business-name"
            type="text"
            value={businessName}
            onChange={e => onChangeName(e.target.value)}
            placeholder="e.g. Acme Inc"
            className="w-full bg-white/5 border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white placeholder:text-neutral-400/50 focus:outline-none focus:border-white/20"
            autoFocus
          />
        </div>

        {/* Business Type */}
        <div>
          <label className="block text-sm text-neutral-400 mb-1.5">Business type</label>
          <div className="grid grid-cols-2 gap-2">
            {BUSINESS_TYPES.map(bt => (
              <button
                key={bt.id}
                data-testid={`onboarding-btype-${bt.id}`}
                onClick={() => onChangeType(bt.id)}
                className={`text-left px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                  businessType === bt.id
                    ? 'border-white/20 bg-white/10 text-white'
                    : 'border-white/[0.08] bg-white/5 text-neutral-400 hover:border-white/20 hover:text-white'
                }`}
              >
                <span className="font-medium block">{bt.label}</span>
                <span className="text-xs text-neutral-400">{bt.tagline}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Business Description */}
        <div>
          <label className="block text-sm text-neutral-400 mb-1.5">What does your business do? (optional)</label>
          <textarea
            data-testid="onboarding-business-desc"
            value={businessDescription}
            onChange={e => onChangeDescription(e.target.value)}
            placeholder="e.g. We help small businesses automate their marketing"
            rows={2}
            className="w-full bg-white/5 border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white placeholder:text-neutral-400/50 focus:outline-none focus:border-white/20 resize-none"
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
            data-testid="onboarding-business-continue"
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
