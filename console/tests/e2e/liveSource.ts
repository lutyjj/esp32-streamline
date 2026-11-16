import { expect, type Page } from '@playwright/test';

/**
 * The id of the source streamline-pcm-source streams into the e2e bridge,
 * once the bridge, which starts beside this run, receives it.
 */
export async function liveSource(page: Page): Promise<string> {
  let id = '';
  await expect
    .poll(
      async () => {
        const answer = await page.request.get('/status').catch(() => null);
        if (!answer?.ok()) return '';
        const status = (await answer.json()) as {
          sources: Record<string, { lifecycle: { state: string } }>;
        };
        id =
          Object.entries(status.sources).find(
            ([, source]) => source.lifecycle.state === 'connected',
          )?.[0] ?? '';
        return id;
      },
      { timeout: 30_000 },
    )
    .not.toBe('');
  return id;
}
