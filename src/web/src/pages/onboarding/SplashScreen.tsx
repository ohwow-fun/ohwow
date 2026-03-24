/**
 * Onboarding Screen 1: Splash
 * "Your AI team, running on your machine."
 */

interface SplashScreenProps {
  onGetStarted: () => void;
}

export function SplashScreen({ onGetStarted }: SplashScreenProps) {
  return (
    <div data-testid="onboarding-splash" className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full text-center space-y-8">
        {/* Wordmark */}
        <div>
          <h1 className="text-5xl font-bold tracking-tight">
            <span className="text-white">ohwow</span>
          </h1>
        </div>

        {/* Headline */}
        <div className="space-y-3">
          <p className="text-xl text-white font-medium">
            Your AI team, running on your machine.
          </p>
          <p className="text-sm text-neutral-400">
            No account needed. No cloud required.
          </p>
        </div>

        {/* CTA */}
        <button
          data-testid="onboarding-get-started"
          onClick={onGetStarted}
          className="w-full bg-white text-black rounded-lg px-6 py-3.5 text-base font-medium hover:bg-neutral-200 transition-colors"
        >
          Get Started
        </button>

        {/* Footer */}
        <p className="text-xs text-neutral-600">
          Free forever for local use
        </p>
      </div>
    </div>
  );
}
