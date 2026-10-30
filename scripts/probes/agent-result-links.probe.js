// Inert, local browser fixture. Domain tests separately prove receipt/History provenance.
async (page) => {
  if (page.url() !== 'http://127.0.0.1:4319/?fixture=chat') throw new Error('Expected the isolated chat fixture');
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('[data-chat-id="chat-2"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('Files and apps', { exact: true }).click();
  await page.getByRole('button', { name: 'q3-summary.md', exact: true }).click();
  const preview = page.locator('.file-preview-dialog');
  await preview.getByText('Quarterly summary', { exact: true }).waitFor();
  const location = await preview.locator('.file-preview-location').textContent();
  if (location !== 'Launch plan · reports/q3-summary.md') throw new Error('The deliverable opened under the wrong work-folder: ' + location);
  await page.screenshot({ path: 'output/playwright/agent-deliverable-link-phone.png' });
  await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  const fileFocusRestored = await page.getByRole('button', { name: 'q3-summary.md', exact: true }).evaluate((button) => button === document.activeElement);
  await page.getByRole('button', { name: 'Quote board', exact: true }).click();
  const dialog = page.locator('.browser-app-dialog');
  await dialog.getByText('Launch plan · 1.0.0 · Updated since this task', { exact: true }).waitFor();
  const app = page.locator('iframe[title="Quote board"]').contentFrame().locator('iframe[title="App content"]').contentFrame();
  await app.getByRole('button', { name: 'Read quote', exact: true }).click();
  await app.getByText('North: $42 per unit, 4 days', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/agent-app-result-link-phone.png' });
  const fits = await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().bottom <= innerHeight);
  await dialog.getByRole('button', { name: 'Close app', exact: true }).click();
  const appFocusRestored = await page.getByRole('button', { name: 'Quote board', exact: true }).evaluate((button) => button === document.activeElement);
  if (!fits || !fileFocusRestored || !appFocusRestored) throw new Error(JSON.stringify({ fits, fileFocusRestored, appFocusRestored }));
  return { deliverableWorkFolderNamed: true, appWorkFolderNamed: true, updatedInstallationDisclosed: true, appQuoteRead: true, fits, fileFocusRestored, appFocusRestored };
}
