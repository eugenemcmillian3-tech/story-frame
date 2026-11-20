import type { NarrationTake } from '../domain/types';
import { isQuotaError } from '../persistence/storage';
import type { RenderSnapshot } from '../render/snapshot';

/**
 * Browser-local media. Uploaded images, uploaded audio, and rendered videos are
 * Blobs in IndexedDB; localStorage only ever holds their stable string ids.
 */
const DB_NAME = 'storyframe.media.v1';
const DB_VERSION = 2;
const ASSETS = 'assets';
const AUDIO = 'audio';
const RENDERS = 'renders';

export interface MediaAssetRecord {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  createdAt: string;
  blob: Blob;
  /** Absent on records written before generated images existed; those are uploads. */
  source?: 'upload' | 'generated';
  generation?: ImageGenerationRecord | null;
  /** The image this one replaced, kept so a replacement can be undone. */
  replacesAssetId?: string | null;
}

/** Provenance recorded with a generated image when it is attached. */
export interface ImageGenerationRecord {
  provider: string;
  model: string;
  prompt: string;
  width: number;
  height: number;
  outputFormat: 'jpeg' | 'png';
  style: string;
  jobId: string;
  generatedAt: string;
  inferenceSeconds: number | null;
}

export interface AudioAssetRecord {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  byteSize: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  createdAt: string;
  blob: Blob;
  /** Absent on records written before generated narration existed; those are uploads. */
  source?: 'upload' | 'generated';
  /** Provenance for a generated take, so a reload can still explain the audio. */
  generation?: NarrationTake | null;
  /** The take this one replaced, kept so the previous narration can be restored. */
  replacesAssetId?: string | null;
}

export interface StoredRenderAudio {
  codec: string;
  sampleRate: number;
  channels: number;
  trackCount: number;
  durationMs: number;
  peakGain: number;
  sourcePeak: number;
}

export interface StoredRenderRecord {
  id: string;
  projectId: string;
  snapshot: RenderSnapshot;
  blob: Blob;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  frameCount: number;
  targetFps: number;
  verifiedFps: number;
  durationMs: number;
  createdAt: string;
  /** Absent on Phase 2A silent renders. */
  audio?: StoredRenderAudio | null;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function mediaStorageError(error: unknown): Error {
  if (isQuotaError(error)) {
    return new Error(
      'This browser is out of storage space. Nothing was saved. Remove an old rendered video or free space, then try again.',
    );
  }
  if (error instanceof Error) return error;
  return new Error('Browser media storage failed. Nothing was saved.');
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
  });
}

export function openMediaDb(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB, so images and renders cannot be stored.'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(mediaStorageError(error));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ASSETS)) {
        const store = database.createObjectStore(ASSETS, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId');
      }
      if (!database.objectStoreNames.contains(AUDIO)) {
        const store = database.createObjectStore(AUDIO, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId');
      }
      if (!database.objectStoreNames.contains(RENDERS)) {
        const store = database.createObjectStore(RENDERS, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(mediaStorageError(request.error));
    request.onblocked = () =>
      reject(new Error('Media storage is blocked by another open tab. Close it and try again.'));
  });
  const tracked = opening.catch((error: unknown) => {
    databasePromise = null;
    throw mediaStorageError(error);
  });
  databasePromise = tracked;
  return tracked;
}

async function putRecord(storeName: string, value: unknown): Promise<void> {
  try {
    const database = await openMediaDb();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
  } catch (error) {
    throw mediaStorageError(error);
  }
}

export async function putAsset(record: MediaAssetRecord): Promise<void> {
  await putRecord(ASSETS, record);
}

export async function getAsset(id: string): Promise<MediaAssetRecord | undefined> {
  try {
    const database = await openMediaDb();
    const transaction = database.transaction(ASSETS, 'readonly');
    return await requestResult(transaction.objectStore(ASSETS).get(id));
  } catch (error) {
    throw mediaStorageError(error);
  }
}

export async function getAssets(ids: string[]): Promise<Map<string, MediaAssetRecord>> {
  const found = new Map<string, MediaAssetRecord>();
  if (ids.length === 0) return found;
  try {
    const database = await openMediaDb();
    const transaction = database.transaction(ASSETS, 'readonly');
    const store = transaction.objectStore(ASSETS);
    const records = await Promise.all(ids.map((id) => requestResult(store.get(id))));
    for (const record of records) {
      if (record) found.set(record.id, record as MediaAssetRecord);
    }
    return found;
  } catch (error) {
    throw mediaStorageError(error);
  }
}

export async function listAllAssets(): Promise<MediaAssetRecord[]> {
  try {
    const database = await openMediaDb();
    const transaction = database.transaction(ASSETS, 'readonly');
    return (await requestResult(transaction.objectStore(ASSETS).getAll())) as MediaAssetRecord[];
  } catch (error) {
    throw mediaStorageError(error);
  }
}

async function deleteRecord(storeName: string, id: string): Promise<void> {
  try {
    const database = await openMediaDb();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(id);
    await transactionDone(transaction);
  } catch (error) {
    throw mediaStorageError(error);
  }
}

export async function deleteAsset(id: string): Promise<void> {
  await deleteRecord(ASSETS, id);
}

export async function putAudioAsset(record: AudioAssetRecord): Promise<void> {
  await putRecord(AUDIO, record);
}

export async function getAudioAsset(id: string): Promise<AudioAssetRecord | undefined> {
  try {
    const database = await openMediaDb();
    const transaction = database.transaction(AUDIO, 'readonly');
    return await requestResult(transaction.objectStore(AUDIO).get(id));
  } catch (error) {
    throw mediaStorageError(error);
  }
}

export async function getAudioAssets(ids: string[]): Promise<Map<string, AudioAssetRecord>> {
  const found = new Map<string, AudioAssetRecord>();
  if (ids.length === 0) return found;
  try {
    const database = await openMediaDb();
    const transaction = database.transaction(AUDIO, 'readonly');
    const store = transaction.objectStore(AUDIO);
    const records = await Promise.all(ids.map((id) => requestResult(store.get(id))));
    for (const record of records) {
      if (record) found.set(record.id, record as AudioAssetRecord);
    }
    return found;
  } catch (error) {
    throw mediaStorageError(error);
  }
}

export async function listAllAudioAssets(): Promise<AudioAssetRecord[]> {
  try {
    const database = await openMediaDb();
    const transaction = database.transaction(AUDIO, 'readonly');
    return (await requestResult(transaction.objectStore(AUDIO).getAll())) as AudioAssetRecord[];
  } catch (error) {
    throw mediaStorageError(error);
  }
}

export async function deleteAudioAsset(id: string): Promise<void> {
  await deleteRecord(AUDIO, id);
}

export async function putRender(record: StoredRenderRecord): Promise<void> {
  await putRecord(RENDERS, record);
}

export async function listRenders(projectId: string): Promise<StoredRenderRecord[]> {
  try {
    const database = await openMediaDb();
    const transaction = database.transaction(RENDERS, 'readonly');
    const records = (await requestResult(
      transaction.objectStore(RENDERS).index('projectId').getAll(projectId),
    )) as StoredRenderRecord[];
    return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch (error) {
    throw mediaStorageError(error);
  }
}

export async function getLatestRender(projectId: string): Promise<StoredRenderRecord | null> {
  const renders = await listRenders(projectId);
  return renders[0] ?? null;
}

export async function deleteRender(id: string): Promise<void> {
  await deleteRecord(RENDERS, id);
}

/** Remove every stored render for a project (used when the project is deleted). */
export async function deleteRendersForProject(projectId: string): Promise<void> {
  await pruneRenders(projectId, 0);
}

/** Keep storage bounded: only the newest few renders per project are kept. */
export async function pruneRenders(projectId: string, keep: number): Promise<number> {
  const renders = await listRenders(projectId);
  const stale = renders.slice(keep);
  for (const render of stale) await deleteRender(render.id);
  return stale.length;
}
