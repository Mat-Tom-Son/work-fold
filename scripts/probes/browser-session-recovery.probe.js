// Real browser boot/recovery with deliberately inconsistent authentication responses.
async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4319/')) throw new Error('Expected the local QA bridge');
  const context = await page.context().browser().newContext();
  const probe = await context.newPage();
  let sessionReads = 0;
  let pairingRequests = 0;
  let loggedIn = false;
  try {
    await probe.route('**/api/**', async (route) => {
      const path = '/' + route.request().url().split('?')[0].split('/').slice(3).join('/');
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (path === '/api/public/context') return json({ addressAvailable: true, authenticated: loggedIn, slug: 'session-recovery-qa' });
      if (path === '/api/auth/login') { loggedIn = true; return json({ authenticated: true, paired: false, desktopOnline: true, csrfToken: 'inert' }); }
      if (path === '/api/auth/session') { sessionReads++; return json({ error: 'Sign in to continue.' }, 401); }
      if (path === '/api/pairings' || path === '/api/auth/bind') { pairingRequests++; return json({ error: 'Sign in to continue.' }, 401); }
      return json({ error: 'Inert recovery test.' }, 401);
    });
    await probe.goto('http://127.0.0.1:4319/?slug=session-recovery-qa');
    await probe.getByRole('textbox', { name: 'Password', exact: true }).fill('Synthetic-test-only');
    await probe.getByRole('button', { name: 'Sign in', exact: true }).click();
    await probe.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    // Give the previous zero-delay reboot loop ample time to reproduce.
    await probe.waitForTimeout(1200);
    if (sessionReads !== 1 || pairingRequests !== 1) throw new Error(JSON.stringify({ sessionReads, pairingRequests }));
    return { returnedToSignIn: true, sessionReads, pairingRequests, noRecoveryLoop: true };
  } finally { await context.close(); }
}
