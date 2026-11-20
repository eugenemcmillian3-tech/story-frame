/**
 * One real, billable generation through the same server module the app uses,
 * on either provider: the create call, the stored job record and the stored
 * bytes. Nothing is attached to a project here.
 *
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... npm run check:image -- --yes
 *   LEONARDO_API_KEY=... npm run check:image -- --model leonardo-phoenix --yes
 *
 * It refuses to run without an explicit confirmation (--yes, or typing "yes")
 * because it spends a real generation on the account.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, MAX_PROMPT_CHARS, imageModel } from '../src/images/provider';
import { fetchImageJobImage, refreshImageJob, submitImageJob } from '../worker/imageJobs';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const modelFlag = process.argv.indexOf('--model');
  const modelId = modelFlag === -1 ? DEFAULT_IMAGE_MODEL : process.argv[modelFlag + 1];
  const spec = modelId ? imageModel(modelId) : null;
  if (!spec) {
    console.error(`Unknown model ${modelId}. Use one of: ${IMAGE_MODELS.map((m) => m.id).join(', ')}`);
    process.exit(2);
  }

  const env = {
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    CF_API_TOKEN: process.env.CF_API_TOKEN,
    LEONARDO_API_KEY: process.env.LEONARDO_API_KEY,
  };
  const missing =
    spec.provider === 'leonardo'
      ? !env.LEONARDO_API_KEY && 'LEONARDO_API_KEY'
      : !(env.CF_ACCOUNT_ID && env.CF_API_TOKEN) && 'CF_ACCOUNT_ID and CF_API_TOKEN';
  if (missing) {
    console.error(`${missing} must be set in this environment. Rerun once ${missing.includes('and') ? 'they are' : 'it is'}.`);
    process.exit(2);
  }

  await confirmSpend(
    `This will generate 1 image with ${spec.label} (${spec.provider}) at ${spec.width}×${spec.height}. ${
      spec.usdEstimate !== null
        ? `Workers AI list price about $${spec.usdEstimate.toFixed(4)}, before the account plan, its free daily allowance and taxes.`
        : 'Leonardo publishes no fixed per-image price; the generation draws from the API balance and the reported credit cost is recorded.'
    }`,
  );

  const db = sqliteDb();
  const prompt =
    'A weathered stone lighthouse on a cold coastal cliff at dawn, low sea mist, ' +
    'wet grass, distant grey ocean, cinematic film still, dramatic directional light, ' +
    'no words, no text, no logos.'.slice(0, MAX_PROMPT_CHARS);

  console.log(`Generating ${id} · ${spec.width}×${spec.height} · ${spec.label} (${spec.model})`);
  const { job } = await submitImageJob(db as never, env, 'live-check', {
    id,
    sceneId: 'scn_live',
    projectId: 'prj_live',
    prompt,
    settings: { modelId: spec.id, style: 'cinema-still' },
  });
  console.log(`  ${job.status}${job.providerJobId ? ` · provider job ${job.providerJobId}` : ''}`);

  let current = job;
  for (let attempt = 0; attempt < 100 && current.status !== 'completed' && current.status !== 'failed'; attempt += 1) {
    await sleep(5_000);
    current = await refreshImageJob(db as never, env, 'live-check', id);
    console.log(`  ${attempt + 1}: ${current.status}`);
  }

  if (current.status !== 'completed') {
    console.error(`Generation ended as ${current.status}: ${current.error ?? 'no detail'}`);
    process.exit(1);
  }

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
  const name =
    spec.provider === 'leonardo' ? `live-generated-scene-leonardo.${extension}` : `live-generated-scene.${extension}`;
  const path = `artifacts/${name}`;
  await writeFile(path, file.bytes);

  console.log(`  ${file.mimeType} · ${(file.bytes.byteLength / 1024).toFixed(0)} KB → ${path}`);
  console.log(
    `  job ${job.id} · ${job.width}×${job.height} · ${
      current.providerCreditCost !== null
        ? `${current.providerCreditCost} API credits reported`
        : 'no provider credit cost reported'
    }`,
  );
  console.log('One real generation succeeded.');
}

await main();
