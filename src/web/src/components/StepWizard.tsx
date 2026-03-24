interface StepWizardProps {
  steps: string[];
  currentStep: number;
  children: React.ReactNode;
}

export function StepWizard({ steps, currentStep, children }: StepWizardProps) {
  return (
    <div>
      {/* Progress dots */}
      <div className="flex items-center gap-2 mb-6">
        {steps.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <div
                className={`w-2 h-2 rounded-full transition-colors ${
                  i < currentStep
                    ? 'bg-success'
                    : i === currentStep
                    ? 'bg-white'
                    : 'bg-white/10'
                }`}
              />
              <span
                className={`text-xs transition-colors ${
                  i === currentStep ? 'text-white font-medium' : 'text-neutral-400'
                }`}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`w-6 h-px ${i < currentStep ? 'bg-success/50' : 'bg-white/10'}`} />
            )}
          </div>
        ))}
      </div>
      {/* Step content */}
      {children}
    </div>
  );
}
