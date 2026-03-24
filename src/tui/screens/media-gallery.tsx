/**
 * Media Gallery Screen
 * Browse, open, and delete saved media files from ~/.ohwow/media/.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { openPath } from '../../lib/platform-utils.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { listMediaFiles, deleteMediaFile, type MediaType, type MediaFileMetadata } from '../../media/storage.js';

type FilterType = 'all' | MediaType;

const FILTER_LABELS: Record<FilterType, string> = {
  all: 'All',
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  presentation: 'Slides',
};

const TYPE_ICONS: Record<MediaType, string> = {
  image: '🖼',
  video: '🎬',
  audio: '🎵',
  presentation: '📊',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

interface MediaGalleryProps {
  onBack: () => void;
}

export function MediaGallery({ onBack }: MediaGalleryProps) {
  const [files, setFiles] = useState<MediaFileMetadata[]>([]);
  const [filter, setFilter] = useState<FilterType>('all');
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<MediaFileMetadata | null>(null);
  const selectedIdxRef = useRef(0);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    const mediaFiles = await listMediaFiles(filter === 'all' ? undefined : filter);
    setFiles(mediaFiles);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    let cancelled = false;
    listMediaFiles(filter === 'all' ? undefined : filter).then(mediaFiles => {
      if (!cancelled) {
        setFiles(mediaFiles);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [filter]);

  useInput((input, key) => {
    if (confirmDelete) {
      if (input === 'y' || input === 'Y') {
        deleteMediaFile(confirmDelete.path)
          .then(() => { setConfirmDelete(null); loadFiles(); })
          .catch(() => setConfirmDelete(null));
      } else if (input === 'n' || input === 'N' || key.escape) {
        setConfirmDelete(null);
      }
      return;
    }

    if (key.escape) { onBack(); return; }

    // Delete selected file
    if (input === 'd' && files.length > 0) {
      const file = files[selectedIdxRef.current];
      if (file) setConfirmDelete(file);
      return;
    }

    // Filter shortcuts
    if (input === '1') setFilter('all');
    if (input === '2') setFilter('image');
    if (input === '3') setFilter('video');
    if (input === '4') setFilter('audio');
    if (input === '5') setFilter('presentation');
  });

  const handleSelect = useCallback((file: MediaFileMetadata) => {
    openPath(file.path);
  }, []);

  const totalSize = files.reduce((sum, f) => sum + f.sizeBytes, 0);

  if (confirmDelete) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="red">Delete this file?</Text>
        <Text color="cyan">{confirmDelete.filename}</Text>
        <Text dimColor>{formatSize(confirmDelete.sizeBytes)}</Text>
        <Box marginTop={1}>
          <Text color="green" bold>[y] Delete    </Text>
          <Text color="red" bold>[n] Cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Media Gallery</Text>
        <Text dimColor>  {files.length} files, {formatSize(totalSize)}</Text>
      </Box>

      {/* Filter tabs */}
      <Box marginBottom={1} gap={1}>
        {(Object.keys(FILTER_LABELS) as FilterType[]).map((f, i) => (
          <Text key={f} color={filter === f ? 'cyan' : 'gray'} bold={filter === f}>
            [{i + 1}] {FILTER_LABELS[f]}
          </Text>
        ))}
      </Box>

      {loading ? (
        <Text dimColor>Loading...</Text>
      ) : (
        <ScrollableList
          items={files}
          onSelect={handleSelect}
          onSelectedIndexChange={(idx) => { selectedIdxRef.current = idx; }}
          emptyMessage="No media files yet. Use the orchestrator to generate images, audio, or presentations."
          renderItem={(file, _idx, isSelected) => (
            <Box gap={1}>
              <Text>{TYPE_ICONS[file.type] || '📄'}</Text>
              <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                {file.filename.length > 40 ? file.filename.slice(0, 37) + '...' : file.filename}
              </Text>
              <Text dimColor>{formatSize(file.sizeBytes)}</Text>
              <Text dimColor>{formatDate(file.createdAt)}</Text>
              {isSelected && <Text color="red" dimColor>[d] delete</Text>}
            </Box>
          )}
        />
      )}

      <Box marginTop={1}>
        <Text dimColor>Enter: open  |  d: delete  |  1-5: filter  |  Esc: back</Text>
      </Box>
    </Box>
  );
}
