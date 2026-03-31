import { useState, useEffect, useRef } from 'react';
import { Microphone, Play, CircleNotch, ArrowClockwise, Waveform } from '@phosphor-icons/react';
import { PageHeader } from '../components/PageHeader';
import { FeatureIntro } from '../components/FeatureIntro';
import { api } from '../api/client';
import { toast } from '../components/Toast';

interface PodcastJob {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  audioUrl?: string;
  error?: string;
  progress?: number;
}

export function PodcastPage() {
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [generating, setGenerating] = useState(false);
  const [job, setJob] = useState<PodcastJob | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleGenerate = async () => {
    if (!content.trim()) return;
    setGenerating(true);
    setJob(null);
    try {
      const res = await api<{ data: { jobId: string } }>('/api/podcast/generate', {
        method: 'POST',
        body: JSON.stringify({
          content: content.trim(),
          title: title.trim() || undefined,
        }),
      });
      const jobId = res.data.jobId;
      setJob({ jobId, status: 'queued' });
      toast('success', 'Podcast generation started');
      startPolling(jobId);
    } catch {
      toast('error', 'Couldn\'t start podcast generation');
    } finally {
      setGenerating(false);
    }
  };

  const startPolling = (jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await api<{ data: PodcastJob }>(`/api/podcast/status/${jobId}`);
        setJob(res.data);
        if (res.data.status === 'completed' || res.data.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (res.data.status === 'completed') {
            toast('success', 'Podcast ready');
          } else {
            toast('error', res.data.error || 'Generation failed');
          }
        }
      } catch {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader title="Podcast" subtitle="Generate audio content from text" />

      <div className="space-y-6">
        {/* Generation form */}
        <div className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-4 space-y-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Title (optional)</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Episode title"
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Content</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="Paste the text you want to convert into a podcast episode..."
              rows={8}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-white/20 resize-none"
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleGenerate}
              disabled={generating || !content.trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 disabled:opacity-50 transition-colors"
            >
              {generating ? <CircleNotch size={14} className="animate-spin" /> : <Microphone size={14} />}
              Generate podcast
            </button>
          </div>
        </div>

        {/* Job status */}
        {job && (
          <div className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-4">
            <div className="flex items-center gap-3 mb-3">
              {job.status === 'queued' || job.status === 'processing' ? (
                <CircleNotch size={18} className="text-blue-400 animate-spin" />
              ) : job.status === 'completed' ? (
                <Waveform size={18} className="text-success" />
              ) : (
                <Microphone size={18} className="text-critical" />
              )}
              <div>
                <p className="text-sm font-medium capitalize">{job.status}</p>
                {job.status === 'processing' && job.progress != null && (
                  <p className="text-xs text-neutral-400">{Math.round(job.progress * 100)}% complete</p>
                )}
              </div>
            </div>

            {job.status === 'processing' && job.progress != null && (
              <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden mb-3">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
              </div>
            )}

            {job.status === 'completed' && job.audioUrl && (
              <audio controls className="w-full mt-2" src={job.audioUrl}>
                Your browser does not support audio playback.
              </audio>
            )}

            {job.status === 'failed' && job.error && (
              <p className="text-xs text-critical">{job.error}</p>
            )}
          </div>
        )}

        {/* Feature intro when no content */}
        {!content && !job && (
          <FeatureIntro
            icon={Microphone}
            title="AI Podcast Generator"
            description="Convert any text content into a natural-sounding podcast episode using local TTS models."
            capabilities={[
              { icon: Microphone, label: 'Text to speech', description: 'Natural-sounding voices' },
              { icon: Waveform, label: 'Audio output', description: 'Download or play in browser' },
              { icon: Play, label: 'Multiple voices', description: 'Different speakers for dialogue' },
            ]}
            variant="compact"
          />
        )}
      </div>
    </div>
  );
}
