import { newId } from '../domain/ids';
import { putAsset } from './mediaDb';
import type { ImageGenerationRecord, MediaAssetRecord } from './mediaDb';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
export const MIN_IMAGE_DIMENSION = 64;
export const ACCEPTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png'] as const;

export interface ImageFileMeta {
  name: string;
  type: string;
  size: number;
}

/**
 * Cheap checks before decoding. Decoding is the real validation; this only
 * rejects obviously unacceptable files with a clear message.
 */
export function validateImageFileMeta(file: ImageFileMeta): string | null {
  if (!(ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Only JPEG and PNG images are supported. Choose a .jpg or .png file.';
  }
  if (file.size <= 0) {
    return 'That file is empty. Choose an image with visible content.';
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `That image is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${
      MAX_IMAGE_BYTES / (1024 * 1024)
    } MB per image.`;
  }
  return null;
}

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/**
 * Decode the actual pixels. A file that claims to be a JPEG but cannot be
 * decoded is rejected here rather than stored and breaking a later render.
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  const metaError = validateImageFileMeta(file);
  if (metaError) throw new Error(metaError);
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This browser cannot decode images for upload.');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      'That file could not be decoded as an image. It may be damaged or not really a JPEG or PNG.',
    );
  }

  if (bitmap.width < MIN_IMAGE_DIMENSION || bitmap.height < MIN_IMAGE_DIMENSION) {
    const size = `${bitmap.width}×${bitmap.height}`;
    bitmap.close();
    throw new Error(
      `That image is ${size}. Images must be at least ${MIN_IMAGE_DIMENSION}×${MIN_IMAGE_DIMENSION}.`,
    );
  }
  if (bitmap.width > MAX_IMAGE_DIMENSION || bitmap.height > MAX_IMAGE_DIMENSION) {
    const size = `${bitmap.width}×${bitmap.height}`;
    bitmap.close();
    throw new Error(
      `That image is ${size}. The maximum side is ${MAX_IMAGE_DIMENSION} px. Resize it and try again.`,
    );
  }

  return { bitmap, width: bitmap.width, height: bitmap.height };
}

/** Validate, decode, and store the original bytes under a stable asset id. */
export async function storeSceneImage(projectId: string, file: File): Promise<MediaAssetRecord> {
  const decoded = await decodeImageFile(file);
  decoded.bitmap.close();
  const record: MediaAssetRecord = {
    id: newId('img'),
    projectId,
    name: file.name.slice(0, 160) || 'Uploaded image',
    mimeType: file.type,
    byteSize: file.size,
    width: decoded.width,
    height: decoded.height,
    createdAt: new Date().toISOString(),
    blob: file,
    source: 'upload',
    generation: null,
    replacesAssetId: null,
  };
  await putAsset(record);
  return record;
}

/**
 * A generated image enters the same store, and therefore the same validation
 * and render path, as an upload. `replacesAssetId` keeps the previous attached
 * image reachable so a replacement can be undone.
 */
export async function storeGeneratedSceneImage(
  projectId: string,
  blob: Blob,
  generation: ImageGenerationRecord,
  replacesAssetId: string | null,
): Promise<MediaAssetRecord> {
  const extension = generation.outputFormat === 'png' ? 'png' : 'jpg';
  const name = `Generated · ${generation.model.split('/').pop() ?? generation.model}.${extension}`;
  const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
  const decoded = await decodeImageFile(file);
  decoded.bitmap.close();
  const record: MediaAssetRecord = {
    id: newId('img'),
    projectId,
    name,
    mimeType: file.type,
    byteSize: file.size,
    width: decoded.width,
    height: decoded.height,
    createdAt: new Date().toISOString(),
    blob: file,
    source: 'generated',
    generation,
    replacesAssetId,
  };
  await putAsset(record);
  return record;
}
