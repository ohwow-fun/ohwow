/**
 * Desktop Session Video Recorder
 * Records the macOS desktop as an H.264 video using FFmpeg and avfoundation.
 * Gracefully degrades to a no-op if FFmpeg is not installed.
 *
 * Inspired by ace-bridge's session recording for audit and debugging.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../lib/logger.js';

const DEFAULT_RECORDING_DIR = join(homedir(), '.ohwow', 'media', 'desktop-recordings');

export class SessionRecorder {
  private ffmpeg: ChildProcess | null = null;
  private outputPath: string | null = null;
  private recording = false;
  private static ffmpegAvailable: boolean | null = null;

  /**
   * Check if FFmpeg is installed. Cached for the process lifetime.
   */
  private static checkFfmpeg(): boolean {
    if (SessionRecorder.ffmpegAvailable !== null) return SessionRecorder.ffmpegAvailable;
    try {
      execSync('which ffmpeg', { encoding: 'utf-8', timeout: 3000 });
      SessionRecorder.ffmpegAvailable = true;
    } catch {
      SessionRecorder.ffmpegAvailable = false;
    }
    return SessionRecorder.ffmpegAvailable;
  }

  /**
   * Start recording the desktop session.
   * @param sessionId - Unique identifier for this recording session
   * @param dataDir - Directory to save recordings. Falls back to ~/.ohwow/media/desktop-recordings/
   */
  async start(sessionId: string, dataDir?: string): Promise<void> {
    if (this.recording) return;

    if (!SessionRecorder.checkFfmpeg()) {
      logger.info('[desktop-recorder] FFmpeg not found, video recording disabled. Install with: brew install ffmpeg');
      return;
    }

    const recordingDir = dataDir ? join(dataDir, 'recordings') : DEFAULT_RECORDING_DIR;
    mkdirSync(recordingDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.outputPath = join(recordingDir, `${sessionId}-${timestamp}.mp4`);

    // Record primary display via avfoundation at 15fps, H.264 ultrafast for low CPU
    const args = [
      '-f', 'avfoundation',
      '-framerate', '15',
      '-capture_cursor', '1',
      '-i', '1:none',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-y',                    // Overwrite output if it exists
      this.outputPath,
    ];

    this.ffmpeg = spawn('ffmpeg', args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: false,
    });

    this.ffmpeg.on('error', (err) => {
      logger.warn(`[desktop-recorder] FFmpeg error: ${err.message}`);
      this.recording = false;
      this.ffmpeg = null;
    });

    this.ffmpeg.on('exit', (code) => {
      if (this.recording) {
        logger.debug(`[desktop-recorder] FFmpeg exited with code ${code}`);
      }
      this.recording = false;
      this.ffmpeg = null;
    });

    // Ensure FFmpeg is killed if the Node process exits unexpectedly
    const cleanup = () => {
      if (this.ffmpeg && !this.ffmpeg.killed) {
        this.ffmpeg.kill('SIGKILL');
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    this.recording = true;
    logger.info(`[desktop-recorder] Recording started: ${this.outputPath}`);
  }

  /**
   * Stop the recording and finalize the MP4 file.
   * @returns Path to the recording, or null if not recording.
   */
  async stop(): Promise<string | null> {
    if (!this.recording || !this.ffmpeg) {
      return null;
    }

    const outputPath = this.outputPath;
    this.recording = false;

    return new Promise<string | null>((resolve) => {
      const proc = this.ffmpeg!;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        this.ffmpeg = null;

        // Log file size
        if (outputPath) {
          try {
            const stats = statSync(outputPath);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
            logger.info(`[desktop-recorder] Recording saved: ${outputPath} (${sizeMB} MB)`);
          } catch {
            logger.info(`[desktop-recorder] Recording saved: ${outputPath}`);
          }
        }

        resolve(outputPath);
      };

      proc.on('exit', finish);

      // Send 'q' to FFmpeg stdin for graceful shutdown (finalizes MP4 container)
      try {
        proc.stdin?.write('q');
        proc.stdin?.end();
      } catch {
        // If stdin write fails, send SIGINT as fallback
        proc.kill('SIGINT');
      }

      // Force kill after 5 seconds if FFmpeg hasn't exited
      setTimeout(() => {
        if (!resolved) {
          logger.warn('[desktop-recorder] FFmpeg did not exit gracefully, force killing');
          proc.kill('SIGKILL');
          finish();
        }
      }, 5000);
    });
  }

  isRecording(): boolean {
    return this.recording;
  }
}
