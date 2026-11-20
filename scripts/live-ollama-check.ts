/**
 * Live Ollama Cloud check: calls the Worker's real generate-and-validate path
 * for every allowlisted model and operation. Needs OLLAMA_API_KEY in the
 * environment; the key is never printed.
 */
import { writeFileSync } from 'node:fs';
import { generateProposal } from '../worker/index';
import { AI_MODELS } from '../src/ai/models';
import type { AiRequestPayload } from '../src/ai/input';

const KEY = process.env.OLLAMA_API_KEY ?? '';
const LOG = 'artifacts/live-ollama-matrix.log';

const OPERATIONS = ['angles', 'script', 'storyboard'] as const;
type Operation = (typeof OPERATIONS)[number];

const sources = [
  {
    id: 'src_1',
    title: 'Bicycle stability primer',
    excerpt:
      'A bicycle stays upright because steering geometry lets the front wheel turn into a fall: when the bike leans, the front wheel steers toward the lean, moving the wheels back under the centre of mass. At very low speeds this self-correction is weaker, and a rider must steer deliberately to keep balance.',
    notes: '',
  },
];

const brief = {
  topic: 'How a bicycle stays upright',
  audience: 'Curious general viewers',
  goal: 'Explain the counterintuitive physics of bicycle balance in under a minute',
  mode: 'factual',
  targetDuration: 60,
  tone: 'clear and curious',
  visualPreset: 'clean-educational',
};

const storyNotes = { characters: '', setting: '', continuity: '' };
const angle = {
  title: 'The lean that corrects itself',
  hook: 'A moving bicycle holds itself up — the trick happens at the front wheel.',
  approach: 'Follow a lean from the front wheel back to the rider.',
  explanation: 'Steering geometry turns a fall into a correction.',
};

const narration =
  'A moving bicycle holds itself up, and the trick happens at the front wheel. When the bike leans, the front wheel steers toward the lean, moving the wheels back under the centre of mass. At very low speeds this self-correction is weaker, so the rider has to steer deliberately to keep balance.';

const INPUTS: Record<Operation, unknown> = {
  angles: { brief, sourceNotes: sources, storyNotes },
  script: { brief, sourceNotes: sources, storyNotes, angle },
  storyboard: { brief, script: { narration, fingerprint: 'live-check-narration' } },
};

function summarize(operation: Operation, proposal: unknown): string {
  if (operation === 'angles') {
    return (proposal as { angles: { title: string }[] }).angles
      .map((item) => item.title)
      .join(' | ');
  }
  if (operation === 'script') {
    const script = proposal as {
      mode: string;
      segments: { claims: unknown[] }[];
      missingInformation: string[];
    };
    if (script.mode === 'outline') {
      return `outline — missing: ${script.missingInformation.join('; ') || 'unspecified'}`;
    }
    const claims = script.segments.reduce((total, segment) => total + segment.claims.length, 0);
    return `${script.segments.length} segments, ${claims} claims`;
  }
  const scenes = (proposal as { scenes: { plannedDuration: number }[] }).scenes;
  return `${scenes.length} scenes, ${scenes.reduce((total, scene) => total + scene.plannedDuration, 0)}s`;
}

async function main() {
  if (!KEY) {
    console.log('No OLLAMA_API_KEY in this environment; cannot run live checks.');
    return;
  }
  const requested = process.argv.slice(2).filter((value) => !value.startsWith('-'));
  const models = requested.length ? requested : AI_MODELS.map((model) => model.id);
  const env = { OLLAMA_API_KEY: KEY, OLLAMA_API_BASE: process.env.OLLAMA_API_BASE };
  const lines: string[] = [];
  let passed = 0;

  for (const model of models) {
    const cells = await Promise.all(
      OPERATIONS.map(async (operation) => {
        const started = Date.now();
        try {
          const proposal = await generateProposal(env, {
            operation,
            model,
            input: INPUTS[operation],
          } as AiRequestPayload);
          passed += 1;
          return `PASS ${Date.now() - started}ms — ${summarize(operation, proposal)}`;
        } catch (error) {
          return `FAIL ${Date.now() - started}ms — ${error instanceof Error ? error.message : String(error)}`;
        }
      }),
    );
    console.log(`${model} | ${cells.join(' | ')}`);
    lines.push(...cells.map((cell, index) => `${model} | ${OPERATIONS[index]} | ${cell}`));
  }

  const total = models.length * OPERATIONS.length;
  console.log(`\n${passed}/${total} checks passed validation.`);
  writeFileSync(
    LOG,
    [`Ollama Cloud live matrix — ${new Date().toISOString()}`, ...lines, `${passed}/${total} passed`, ''].join('\n'),
  );
}

main().catch((error) => {
  console.log('HARNESS FAILED —', error instanceof Error ? error.message : String(error));
});
