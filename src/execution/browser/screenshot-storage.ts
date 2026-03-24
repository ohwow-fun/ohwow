/**
 * Local Screenshot Storage
 *
 * Saves screenshot images to the local filesystem when running
 * in local mode (no Supabase Storage available).
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export async function saveScreenshotLocally(
  base64Data: string,
  dataDir: string,
): Promise<{ path: string }> {
  const screenshotsDir = join(dataDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });

  const filename = `${Date.now()}.jpg`;
  const filePath = join(screenshotsDir, filename);

  const buffer = Buffer.from(base64Data, 'base64');
  await writeFile(filePath, buffer);

  return { path: filePath };
}
