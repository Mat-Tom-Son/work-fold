// Run with Playwright CLI run-code against the inert local Spaces fixture on port 4319.
async (page) => {
  if (page.url() !== 'http://127.0.0.1:4319/?fixture=spaces') throw new Error('Expected the isolated fixture');
  await page.reload();
  await page.getByRole('button', { name: 'Quote board', exact: true }).click();
  const app = page.locator('iframe[title="Quote board"]').contentFrame().locator('iframe[title="App content"]').contentFrame();
  await app.getByRole('button', { name: 'Read quote', exact: true }).click();
  await app.getByText('North: $42 per unit, 4 days', {exact: true}).waitFor();
  const quote = await app.getByRole('status').textContent();
  if (quote !== 'North: $42 per unit, 4 days') throw new Error('The brokered quote read failed: ' + quote);
  const outcomes = await app.getByRole('button', { name: 'Read quote', exact: true }).evaluate(async () => {
    const denied = (operation) => { try { operation(); return false; } catch { return true; } };
    const result = {
      parentDomDenied: denied(() => parent.document.body.textContent),
      managementDomDenied: denied(() => top.document.body.textContent),
      cookiesDenied: denied(() => document.cookie),
      storageDenied: denied(() => localStorage.length),
      frozenApi: Object.isFrozen(workFoldViewerApp) && Object.isFrozen(workFoldViewerApp.data),
      noWriteApi: !('set' in workFoldViewerApp.data),
      noActionApi: !('actions' in workFoldViewerApp),
      networkDenied: false,
    };
    try { await fetch('http://127.0.0.1:4319/api/auth/session?isolation-probe=1'); } catch { result.networkDenied = true; }
    location.href = 'http://127.0.0.1:4319/browser-app-frame.html?isolation-navigation-probe=1';
    return result;
  });
  if (Object.values(outcomes).some(value => value !== true)) throw new Error(JSON.stringify(outcomes));
  await page.getByText('This app left its web view. Refresh to open it again.', {exact: true}).waitFor();
  return { quote, ...outcomes, navigationDenied: true };
}
