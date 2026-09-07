// Requires the explicitly paired local QA browser and one already-reviewed order.
async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4319/?slug=paired-apps-qa')) throw new Error('Expected the paired QA browser');
  const app = page.locator('iframe[title="Quote board QA"]').contentFrame().locator('iframe[title="App content"]').contentFrame();
  const result = app.locator('#result');
  await app.getByRole('button', { name: 'Read order', exact: true }).click();
  await result.filter({ hasText: '"sequence": 1' }).waitFor();
  const order = JSON.parse(await result.textContent());
  if (order.sequence !== 1 || order.quantity !== 10 || order.total !== 420) throw new Error('Unexpected native worker result');
  await app.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await result.filter({ hasText: '"status": "succeeded"' }).waitFor();
  const receipt = JSON.parse(await result.textContent());
  if (receipt.requestId !== '61ad052c-fe80-44f6-b135-15b6bbce0b82') throw new Error('Retry changed request identity');
  await app.getByRole('button', { name: 'Read order', exact: true }).click();
  await result.filter({ hasText: '"sequence": 1' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'output/playwright/paired-native-order-phone.png' });
  const fits = await page.locator('.browser-app-dialog').evaluate((node) => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().bottom <= innerHeight);
  if (!fits) throw new Error('App escaped its phone dialog');
  return { actualDesktopWorker: true, order, sameRequest: receipt.requestId, oneEffectAfterRetry: true, phoneContained: fits };
}
