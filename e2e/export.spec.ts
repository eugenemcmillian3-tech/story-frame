import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const PROJECT_ID = 'prj_e2e_export';
const SCENE_SECONDS = 1;
const SCENES = 2;
const AUDIO_SECONDS = SCENE_SECONDS * SCENES;
const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 30;

interface Box {
  type: string;
  dataStart: number;
  end: number;
}

/** MP4 boxes are length-prefixed; walk only the children of `parent`. */
function readBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    boxes.push({ type, dataStart: offset + header, end: offset + size });
    offset += size;
  }
  return boxes;
}

function child(bytes: Uint8Array, parent: Box, type: string): Box | undefined {
  return readBoxes(bytes, parent.dataStart, parent.end).find((box) => box.type === type);
}

function requiredChild(bytes: Uint8Array, parent: Box, type: string): Box {
  const found = child(bytes, parent, type);
  expect(found, `expected an MP4 ${type} box`).toBeDefined();
  return found as Box;
}

/** Read the movie header and every track's handler and sample-entry types. */
function readMp4(bytes: Uint8Array) {
  const moov = readBoxes(bytes, 0, bytes.length).find((box) => box.type === 'moov');
  expect(moov, 'expected a moov box').toBeDefined();
  const movie = moov as Box;
  const mvhd = requiredChild(bytes, movie, 'mvhd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(mvhd.dataStart);
  const timescale = view.getUint32(mvhd.dataStart + (version === 1 ? 20 : 12));
  const duration =
    version === 1
      ? Number(view.getBigUint64(mvhd.dataStart + 24))
      : view.getUint32(mvhd.dataStart + 16);

  const tracks = readBoxes(bytes, movie.dataStart, movie.end)
    .filter((box) => box.type === 'trak')
    .map((trak) => {
      const mdia = requiredChild(bytes, trak, 'mdia');
      const hdlr = requiredChild(bytes, mdia, 'hdlr');
      const handler = String.fromCharCode(...bytes.subarray(hdlr.dataStart + 8, hdlr.dataStart + 12));
      const stbl = requiredChild(bytes, requiredChild(bytes, mdia, 'minf'), 'stbl');
      const stsd = requiredChild(bytes, stbl, 'stsd');
      const sampleEntries = readBoxes(bytes, stsd.dataStart + 8, stsd.end).map((box) => box.type);
      return { handler, sampleEntries };
    });

  return {
    timescale,
    durationSeconds: duration / timescale,
    tracks,
  };
}

test('renders a two-scene MP4 with video and audio tracks', async ({ page }) => {
  await page.goto('/');

  const seeded = await page.evaluate(
    async ({ projectId, sceneSeconds, scenes, audioSeconds }) => {
      // These are Vite dev-server modules, so the fixture uses the app's own
      // domain and IndexedDB writers instead of duplicating their shapes.
      const load = (path: string): Promise<Record<string, any>> => import(/* @vite-ignore */ path);
      const projectModule = await load('/src/domain/project.ts');
      const storyboardModule = await load('/src/domain/storyboard.ts');
      const mediaModule = await load('/src/media/mediaDb.ts');

      const now = '2026-01-01T00:00:00.000Z';
      const makeImage = async (id: string, label: string, from: string, to: string) => {
        const canvas = document.createElement('canvas');
        canvas.width = 720;
        canvas.height = 1280;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('The test browser could not create a 2D canvas.');
        const gradient = context.createLinearGradient(0, 0, 720, 1280);
        gradient.addColorStop(0, from);
        gradient.addColorStop(1, to);
        context.fillStyle = gradient;
        context.fillRect(0, 0, 720, 1280);
        context.fillStyle = '#ffffff';
        context.font = 'bold 96px sans-serif';
        context.textAlign = 'center';
        context.fillText(label, 360, 640);
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('No PNG bytes.'))), 'image/png');
        });
        await mediaModule.putAsset({
          id,
          projectId,
          name: `${id}.png`,
          mimeType: 'image/png',
          byteSize: blob.size,
          width: 720,
          height: 1280,
          createdAt: now,
          blob,
          source: 'upload',
          generation: null,
          replacesAssetId: null,
        });
        return { id, byteSize: blob.size };
      };

      const makeWav = async (id: string, seconds: number) => {
        const sampleRate = 48_000;
        const samples = sampleRate * seconds;
        const buffer = new ArrayBuffer(44 + samples * 2);
        const view = new DataView(buffer);
        const write = (offset: number, text: string) => {
          for (let index = 0; index < text.length; index += 1) {
            view.setUint8(offset + index, text.charCodeAt(index));
          }
        };
        write(0, 'RIFF');
        view.setUint32(4, 36 + samples * 2, true);
        write(8, 'WAVE');
        write(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        write(36, 'data');
        view.setUint32(40, samples * 2, true);
        for (let index = 0; index < samples; index += 1) {
          const sample = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.25;
          view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true);
        }
        const blob = new Blob([buffer], { type: 'audio/wav' });
        await mediaModule.putAudioAsset({
          id,
          projectId,
          name: `${id}.wav`,
          mimeType: 'audio/wav',
          byteSize: blob.size,
          durationMs: seconds * 1000,
          sampleRate,
          channels: 1,
          createdAt: now,
          blob,
          source: 'upload',
          generation: null,
          replacesAssetId: null,
        });
        return { id, byteSize: blob.size };
      };

      const firstImage = await makeImage('img_e2e_one', 'SCENE ONE', '#1d4ed8', '#0f172a');
      const secondImage = await makeImage('img_e2e_two', 'SCENE TWO', '#b91c1c', '#1c1917');
      const audio = await makeWav('aud_e2e_tone', audioSeconds);

      let project = projectModule.createProject(
        {
          title: 'E2E export',
          mode: 'fiction',
          targetDuration: 30,
          visualPreset: 'clean-educational',
        },
        { now, id: projectId },
      );
      project = storyboardModule.addScene(
        project,
        { title: 'One', plannedDuration: sceneSeconds, onScreenText: 'SCENE ONE' },
        now,
      );
      project = storyboardModule.addScene(
        project,
        { title: 'Two', plannedDuration: sceneSeconds, onScreenText: 'SCENE TWO' },
        now,
      );
      const scenesOnBoard = project.storyboard.scenes;
      if (scenesOnBoard.length !== scenes) throw new Error('The fixture did not add two scenes.');
      project = storyboardModule.updateScene(project, scenesOnBoard[0].id, { imageAssetId: firstImage.id }, now);
      project = storyboardModule.updateScene(project, scenesOnBoard[1].id, { imageAssetId: secondImage.id }, now);
      project = projectModule.updateAudioTrack(
        project,
        'narration',
        { assetId: audio.id, fileName: 'tone.wav', durationMs: audioSeconds * 1000 },
        now,
      );

      localStorage.setItem(`storyframe.v1.project.${projectId}`, JSON.stringify(project));
      return { scenes: scenesOnBoard.length, images: [firstImage, secondImage], audio };
    },
    {
      projectId: PROJECT_ID,
      sceneSeconds: SCENE_SECONDS,
      scenes: SCENES,
      audioSeconds: AUDIO_SECONDS,
    },
  );

  expect(seeded.scenes).toBe(SCENES);
  expect(seeded.images.every((image: { byteSize: number }) => image.byteSize > 0)).toBe(true);
  expect(seeded.audio.byteSize).toBeGreaterThan(0);

  await page.goto(`/#/projects/${PROJECT_ID}/export`);
  await expect(page.getByRole('heading', { name: 'Export' })).toBeVisible();
  await expect(page.getByText('MP4 · uploaded audio')).toBeVisible();

  await page.getByRole('button', { name: 'Render MP4 with audio' }).click();

  await expect(page.locator('.render-state')).toHaveText('Render completed', { timeout: 120_000 });

  const video = page.locator('video.render-video');
  await expect(video).toBeVisible();
  await expect
    .poll(
      async () =>
        video.evaluate((element) => {
          const player = element as HTMLVideoElement;
          return player.readyState >= 1 && Number.isFinite(player.duration) && player.duration > 0;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  const measured = await video.evaluate((element) => {
    const player = element as HTMLVideoElement;
    return {
      duration: player.duration,
      width: player.videoWidth,
      height: player.videoHeight,
    };
  });
  expect(measured.duration).toBeGreaterThan(AUDIO_SECONDS - 0.15);
  expect(measured.duration).toBeLessThan(AUDIO_SECONDS + 0.15);
  expect(measured.width).toBe(WIDTH);
  expect(measured.height).toBe(HEIGHT);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download MP4' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('e2e-export-with-audio-720x1280.mp4');
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const bytes = await readFile(downloadPath as string);
  expect(bytes.byteLength).toBeGreaterThan(10_000);

  const mp4 = readMp4(bytes);
  expect(mp4.tracks.map((track) => track.handler).sort()).toEqual(['soun', 'vide']);
  expect(mp4.tracks.find((track) => track.handler === 'vide')?.sampleEntries).toContain('avc1');
  expect(
    mp4.tracks
      .find((track) => track.handler === 'soun')
      ?.sampleEntries.map((entry) => entry.toLowerCase()),
  ).toContain('opus');
  expect(mp4.durationSeconds).toBeGreaterThan(AUDIO_SECONDS - 0.1);
  expect(mp4.durationSeconds).toBeLessThan(AUDIO_SECONDS + 0.1);

  await expect(page.locator('.render-details')).toContainText('OPUS');
  await expect(page.locator('.render-details')).toContainText('1 mixed track');
  await expect(page.locator('.render-details')).toContainText(`${WIDTH} × ${HEIGHT}`);
  // The container's frame count is the encoded truth, not the planned duration.
  await expect(
    page.locator('.render-details > div').filter({ hasText: 'Frames encoded' }).locator('dd'),
  ).toHaveText(String(SCENES * SCENE_SECONDS * FPS));

  // TEMPORARY: force a red run so CI's trace upload can be verified.
  throw new Error('Forced failure to verify the Playwright trace upload');
});
