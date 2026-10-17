import { expect, test } from '@playwright/test';

for (const width of [300, 375, 430])
    for (const scale of [100, 130])
        for (const kind of ['rain', 'wave']) {
            test(`141 ${kind} agreement fits unchanged card slots at ${width}/${scale}`, async ({ page }, info) => {
                await page.setViewportSize({ width, height: 780 });
                const external: string[] = [];
                await page.route('**/*', (route) => {
                    const url = new URL(route.request().url());
                    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
                    external.push(url.origin);
                    return route.abort();
                });
                await page.goto(`/e2e/fixtures/weather-agreement141.html?kind=${kind}&scale=${scale}`);
                await page.evaluate(() => document.fonts.ready);
                for (const height of [109, 156, 230]) {
                    const frame = page.getByTestId(`weather-card-${height}`);
                    const chip = frame.getByRole('button', {
                        name: kind === 'rain' ? /^Rain: models split/ : /^Waves: models split/,
                    });
                    await expect(chip).toBeVisible();
                    await expect
                        .poll(() =>
                            frame.evaluate((node) => {
                                const card = node.querySelector<HTMLElement>('[role="group"]')!;
                                const content = node.querySelector<HTMLElement>('[data-testid="day-card-content"]')!;
                                return (
                                    content.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom + 0.5
                                );
                            }),
                        )
                        .toBe(true);
                    const before = await frame.boundingBox();
                    const fit = await chip.evaluate((node) => {
                        const box = node.getBoundingClientRect();
                        const card = node.closest('[role="group"]')!.getBoundingClientRect();
                        const pseudo = getComputedStyle(node, '::before');
                        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                        const overlaps =
                            node.dataset.placement === 'corner'
                                ? [
                                      ...node
                                          .closest('[role="group"]')!
                                          .querySelectorAll<HTMLElement>('[data-testid="day-card-content"] span'),
                                  ]
                                      .filter((el) => !el.closest('.sr-only'))
                                      .filter((el) => {
                                          const r = el.getBoundingClientRect();
                                          return (
                                              r.width > 0 &&
                                              r.left < box.right &&
                                              r.right > box.left &&
                                              r.top < box.bottom &&
                                              r.bottom > box.top
                                          );
                                      })
                                      .map((el) => el.textContent)
                                : [];
                        return {
                            // The inherited corner control's 44px transparent
                            // pseudo hit area deliberately exceeds its 16px
                            // glyph. Judge visible children there; require the
                            // actual text row's scrollWidth when words draw.
                            horizontal:
                                node.dataset.placement === 'corner'
                                    ? [...node.children].every((child) => {
                                          const r = child.getBoundingClientRect();
                                          return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
                                      })
                                    : node.scrollWidth <= node.clientWidth + 1,
                            inside:
                                box.left >= card.left &&
                                box.right <= card.right &&
                                box.top >= card.top &&
                                box.bottom <= card.bottom,
                            hit: !!hit && node.contains(hit),
                            touch: [parseFloat(pseudo.width), parseFloat(pseudo.height)],
                            overlaps,
                        };
                    });
                    expect(fit).toEqual({ horizontal: true, inside: true, hit: true, touch: [44, 44], overlaps: [] });
                    await chip.click();
                    expect(await frame.boundingBox()).toEqual(before);
                }
                expect(await page.evaluate(() => window.__weatherAgreement141)).toEqual({ clicks: 3, driver: kind });
                expect(
                    await page.evaluate(
                        () =>
                            document.documentElement.scrollWidth <= innerWidth &&
                            document.documentElement.scrollHeight <= innerHeight,
                    ),
                ).toBe(true);
                await page.screenshot({ path: info.outputPath(`${kind}-${width}-${scale}.png`) });
                expect(external.filter((url) => !url.includes('sentry'))).toEqual([]);
            });
        }
