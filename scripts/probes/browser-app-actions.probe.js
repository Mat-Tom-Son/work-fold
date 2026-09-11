// Inert local UI fixture only. Domain, transport and Electron tests cover real execution.
async (page) => {
  if (page.url() !== 'http://127.0.0.1:4319/?fixture=spaces') throw new Error('Expected the isolated fixture');
  await page.reload();
  await page.getByRole('button', { name: 'Quote board', exact: true }).click();
  const app = page.locator('iframe[title="Quote board"]').contentFrame().locator('iframe[title="App content"]').contentFrame();
  await app.getByRole('button', { name: 'Save quote', exact: true }).click();
  // A request runs as soon as the fixture accepts it: the app sees running, then succeeded.
  await app.getByRole('status').filter({ hasText: /running|succeeded/ }).waitFor();
  const isolation = await app.getByRole('button', { name: 'Save quote', exact: true }).evaluate(async () => {
    const denied = await new Promise((resolve) => {
      const listener = (event) => {
        if (event.source !== parent || event.data?.type !== 'work-fold.browser-app.result' || event.data.callId !== 99999) return;
        removeEventListener('message', listener); clearTimeout(timer); resolve(event.data.code === 'APP_DENIED');
      };
      const timer = setTimeout(() => { removeEventListener('message', listener); resolve(false); }, 3000);
      addEventListener('message', listener);
      parent.postMessage({ type: 'work-fold.browser-app.call', callId: 99999, call: { kind: 'actions.approve', requestId: 'forged', reviewDigest: 'forged' } }, '*');
    });
    const actions = workFoldBrowserApp.actions;
    const prepared = actions.createRequest('save-quote', { quantity: 10 });
    const listed = (await actions.list())[0];
    return { opaqueRequestIdentity: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(prepared.requestId),
      frozen: Object.isFrozen(workFoldBrowserApp) && Object.isFrozen(actions), noApprovalApi: !('approve' in actions) && !('review' in actions), forgedCallDenied: denied,
      ranOnAcceptance: ['running', 'succeeded'].includes(listed?.status), viewerStillReadOnly: !('actions' in workFoldViewerApp) && !('set' in workFoldViewerApp.data) };
  });
  if (Object.values(isolation).some(value => value !== true)) throw new Error(JSON.stringify(isolation));
  const controls = page.getByRole('region', { name: 'App requests', exact: true });
  await controls.getByRole('button', { name: 'Run', exact: true }).waitFor({ state: 'detached', timeout: 500 }).catch(() => { throw new Error('A Run control appeared; requests must run on acceptance'); });
  await controls.getByText('Done', { exact: true }).waitFor();
  await controls.getByRole('button', { name: 'View', exact: true }).first().click();
  const result = await controls.getByLabel('Action result').textContent();
  if (!result.includes('"saved": true')) throw new Error('The trusted parent did not show the action result');
  await app.getByRole('button', { name: 'Check request', exact: true }).click();
  await app.getByRole('status').filter({ hasText: '"runs":1' }).waitFor();
  await app.getByRole('button', { name: 'Save quote', exact: true }).click();
  await app.getByRole('status').filter({ hasText: 'succeeded' }).waitFor();
  await app.getByRole('button', { name: 'Check request', exact: true }).click();
  await app.getByRole('status').filter({ hasText: '"runs":1' }).waitFor();
  await page.getByRole('button', { name: 'Close app', exact: true }).click();
  await page.getByRole('button', { name: 'Quote board', exact: true }).click();
  await controls.getByRole('button', { name: 'View', exact: true }).click();
  await controls.getByLabel('Action result').filter({ hasText: '"runs": 1' }).waitFor();
  await page.setViewportSize({ width: 320, height: 568 });
  const bounds = await page.locator('.browser-app-dialog').evaluate((dialog) => ({ width: dialog.getBoundingClientRect().width, height: dialog.getBoundingClientRect().height,
    noHorizontalOverflow: dialog.scrollWidth <= dialog.clientWidth, viewportFits: dialog.getBoundingClientRect().bottom <= innerHeight }));
  if (!bounds.noHorizontalOverflow || !bounds.viewportFits) throw new Error(JSON.stringify(bounds));
  await page.screenshot({ path: 'output/playwright/browser-app-actions-phone.png' });
  await page.keyboard.press('Escape');
  if (await page.locator('iframe[title="Quote board"]').count()) throw new Error('Closing left app code mounted');
  const focusRestored = await page.getByRole('button', { name: 'Quote board', exact: true }).evaluate((button) => button === document.activeElement);
  if (!focusRestored) throw new Error('App opener focus was not restored');
  return { ...isolation, resultShown: true, receiptRecovered: true, duplicateRuns: 1, focusRestored, ...bounds };
}
