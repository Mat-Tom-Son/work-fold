// Start this probe, then quit the isolated QA desktop through its normal Quit action.
async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4319/?slug=paired-apps-qa')) throw new Error('Expected paired QA');
  await page.getByRole('button', { name: 'Quote board QA · Preview', exact: true }).click();
  await page.getByText('Desktop offline. Reconnect and refresh to open this app.', { exact: true }).waitFor({ timeout: 30000 });
  let operations = 0;
  // Accepted receipts may still be read from the relay's bounded response cache.
  const listener = request => { if (request.method() === 'POST' && request.url().includes('/api/operations')) operations++; };
  page.on('request', listener);
  try { await page.waitForTimeout(12000); } finally { page.off('request', listener); }
  const frames = await page.locator('.browser-app-dialog iframe').count();
  if (operations || frames) throw new Error(JSON.stringify({ operations, frames }));
  return { offlineFrameCleared: true, newOrRecoveredDispatchesDuringOfflineWindow: operations };
}
