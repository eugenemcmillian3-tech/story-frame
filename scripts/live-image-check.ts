/**
 * One real, billable Workers AI generation through the same server module the
 * app uses: the create call, the stored job record and the stored bytes.
 * Nothing is attached to a project here.
 *
 * Requires the account credentials the Worker also uses:
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... npm run check:image -- --yes
 *
 * It refuses to run without an explicit confirmation (--yes, or typing "yes"),
 * because it spends a real generation on the account.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  IMAGE_MODEL,
  IMAGE_MODEL_LABEL,
  IMAGE_SIZE,
  IMAGE_STEPS,
  IMAGE_USD_ESTIMATE,
} from '../src/images/provider';
import { fetchImageJobImage, submitImageJob } from '../worker/imageJobs';
import { confirmSpend } from './confirm-spend';

const id = `ij_live_${Date.now().toString(36)}`;

function sqliteDb() {
  const database = new DatabaseSync(':memory:');
  return {
    prepare(query: string) {
      const statement = database.prepare(query);
      let args: unknown[] = [];
      const bound = {
        bind(...values: unknown[]) {
          args = values;
          return bound;
        },
        async all<T = unknown>() {
          return { results: statement.all(...(args as never[])) as T[] };
        },
        async run() {
          statement.run(...(args as never[]));
          return {};
        },
      };
      return bound;
    },
  };
}

async function main() {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error('CF_ACCOUNT_ID and CF_API_TOKEN must be set in this environment. Rerun once they are.');
    process.exit(2);
  }

  await confirmSpend(
    `This will generate 1 image with ${IMAGE_MODEL_LABEL} (${IMAGE_MODEL}) at ${IMAGE_SIZE}×${IMAGE_SIZE}, ${IMAGE_STEPS} steps. Workers AI list price: about $${IMAGE_USD_ESTIMATE.toFixed(4)}, before the account plan, its free daily allowance and taxes.`,
  );

  const db = sqliteDb();
  const env = { CF_ACCOUNT_ID: accountId, CF_API_TOKEN: apiToken };
  const prompt =
    'A weathered stone lighthouse on a cold coastal cliff at dawn, low sea mist, ' +
    'wet grass, distant grey ocean, cinematic film still, dramatic directional light, ' +
    'no words, no text, no logos.';

  console.log(`Generating ${id} · ${IMAGE_SIZE}×${IMAGE_SIZE} · ${IMAGE_MODEL_LABEL}`);
  const { job } = await submitImageJob(db as never, env, 'live-check', {
    id,
    sceneId: 'scn_live',
    projectId: 'prj_live',
    prompt,
    settings: { model: IMAGE_MODEL, steps: IMAGE_STEPS, style: 'cinema-still' },
  });
  console.log(`  ${job.status} in ${job.inferenceSeconds?.toFixed(2) ?? '?'}s · ${job.error ?? 'no error'}`);

  if (job.status !== 'completed') process.exit(1);

  const file = await fetchImageJobImage(db as never, 'live-check', id);
  const isPng =
    file.bytes[0] === 0x89 && file.bytes[1] === 0x50 && file.bytes[2] === 0x4e && file.bytes[3] === 0x47;
  const isJpeg = file.bytes[0] === 0xff && file.bytes[1] === 0xd8;
  if (!isPng && !isJpeg) {
    console.error('Stored bytes are not a PNG or JPEG.');
    process.exit(1);
  }
  await mkdir('artifacts', { recursive: true });
  const extension = file.mimeType === 'image/png' ? 'png' : 'jpg';
  const path = `artifacts/live-generated-scene.${extension}`;
  await writeFile(path, file.bytes);

  console.log(`  ${file.mimeType} · ${(file.bytes.byteLength / 1024).toFixed(0)} KB → ${path}`);
  console.log(`  job ${job.id} · model ${job.model} · ${job.width}×${job.height}`);
  console.log('One real Workers AI generation succeeded.');
}

await main();
