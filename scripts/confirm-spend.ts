import { createInterface } from 'node:readline/promises';

/**
 * A live image check spends one real Workers AI generation on the account. It
 * never runs silently: an operator either passes --yes or types "yes" at the
 * prompt, and the message says exactly what will be spent first.
 */
export async function confirmSpend(description: string): Promise<void> {
  if (process.argv.includes('--yes')) {
    console.log(`Confirmed with --yes: ${description}`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.error(
      `${description}\nNothing was generated: this command spends a real generation, so it needs an explicit confirmation. Rerun with --yes, or run it in a terminal and answer the prompt.`,
    );
    process.exit(2);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`${description}\nType "yes" to spend one generation: `);
    if (answer.trim().toLowerCase() !== 'yes') {
      console.error('Not confirmed. Nothing was generated.');
      process.exit(2);
    }
  } finally {
    prompt.close();
  }
}
