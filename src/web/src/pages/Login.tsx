import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { setToken, api } from '../api/client';

export function LoginPage() {
  const [token, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;

    setLoading(true);
    setError('');

    try {
      setToken(token.trim());
      await api('/api/session');
      navigate('/', { replace: true });
    } catch {
      setError('Invalid session token. Check your terminal for the correct token.');
      setToken('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold">
            <span className="text-white">ohwow</span>
            <span className="text-neutral-400 ml-1">runtime</span>
          </h1>
          <p className="text-sm text-neutral-400 mt-2">
            Enter the session token from your terminal to connect.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={token}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="Paste session token here"
              autoFocus
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20 transition-colors font-mono"
            />
          </div>

          {error && (
            <p className="text-xs text-critical">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="w-full bg-white text-black rounded-lg px-4 py-3 text-sm font-medium hover:bg-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  );
}
