import { useState, useEffect } from 'react';
import { Browser, ArrowClockwise, Camera, TreeStructure, CircleNotch } from '@phosphor-icons/react';
import { PageHeader } from '../components/PageHeader';
import { FeatureIntro } from '../components/FeatureIntro';
import { api } from '../api/client';
import { toast } from '../components/Toast';

interface BrowserHealth {
  active: boolean;
  url?: string;
  title?: string;
}

export function BrowserViewerPage() {
  const [health, setHealth] = useState<BrowserHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);

  const checkHealth = async () => {
    try {
      const res = await fetch('/browser/health');
      if (res.ok) {
        const data = await res.json();
        setHealth({ active: true, url: data.url, title: data.title });
      } else {
        setHealth({ active: false });
      }
    } catch {
      setHealth({ active: false });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { checkHealth(); }, []);

  const takeScreenshot = async () => {
    setCapturing(true);
    try {
      const res = await fetch('/browser/session/screenshot');
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setScreenshot(url);
      } else {
        toast('error', 'Couldn\'t capture screenshot');
      }
    } catch {
      toast('error', 'Browser session not active');
    } finally {
      setCapturing(false);
    }
  };

  const takeSnapshot = async () => {
    setSnapshotting(true);
    try {
      const res = await api<{ data: string }>('/browser/session/snapshot');
      setSnapshot(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2));
    } catch {
      toast('error', 'Couldn\'t get accessibility snapshot');
    } finally {
      setSnapshotting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-4xl">
        <PageHeader title="Browser" subtitle="Browser automation viewer" />
        <div className="flex items-center gap-2 text-neutral-400 text-sm">
          <CircleNotch size={14} className="animate-spin" /> Checking browser status...
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Browser"
        subtitle="Browser automation viewer"
        action={
          <button
            onClick={checkHealth}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-400 border border-white/10 rounded-md hover:bg-white/5 hover:text-white transition-colors"
          >
            <ArrowClockwise size={14} /> Refresh
          </button>
        }
      />

      {!health?.active ? (
        <FeatureIntro
          icon={Browser}
          title="No active browser session"
          description="Browser sessions are started automatically when agents need web access. Launch a task that requires browsing to see it here."
          capabilities={[
            { icon: Camera, label: 'Screenshots', description: 'Capture the current page' },
            { icon: TreeStructure, label: 'Accessibility tree', description: 'View page structure' },
            { icon: Browser, label: 'Live view', description: 'See what your agent sees' },
          ]}
        />
      ) : (
        <div className="space-y-6">
          {/* Session info */}
          <div className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-4">
            <div className="flex items-center gap-3 mb-2">
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
              <span className="text-sm font-medium">Active session</span>
            </div>
            {health.url && <p className="text-xs text-neutral-400 truncate ml-5">{health.url}</p>}
            {health.title && <p className="text-xs text-neutral-500 ml-5">{health.title}</p>}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={takeScreenshot}
              disabled={capturing}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
            >
              {capturing ? <CircleNotch size={14} className="animate-spin" /> : <Camera size={14} />}
              Capture screenshot
            </button>
            <button
              onClick={takeSnapshot}
              disabled={snapshotting}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white/5 border border-white/10 text-white rounded-md hover:bg-white/10 disabled:opacity-50 transition-colors"
            >
              {snapshotting ? <CircleNotch size={14} className="animate-spin" /> : <TreeStructure size={14} />}
              Accessibility tree
            </button>
          </div>

          {/* Screenshot display */}
          {screenshot && (
            <div>
              <h3 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-2">Screenshot</h3>
              <div className="border border-white/[0.08] rounded-lg overflow-hidden">
                <img src={screenshot} alt="Browser screenshot" className="w-full" />
              </div>
            </div>
          )}

          {/* Snapshot display */}
          {snapshot && (
            <div>
              <h3 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-2">Accessibility tree</h3>
              <pre className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-4 text-xs text-neutral-400 overflow-x-auto max-h-96 whitespace-pre-wrap font-mono">
                {snapshot}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
