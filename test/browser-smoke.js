async page => {
  const checks = [];
  const errors = [];
  const flightEvents = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/telemetry')) flightEvents.push(...request.postDataJSON().events);
  });
  page.on('pageerror', e => errors.push(e.message));
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:3000');
  await page.waitForFunction(() => window.pipeworks?.getState().phase === 'ready');
  await page.getByRole('button', { name: 'Let’s fly', exact: true }).click();
  await page.waitForFunction(() => window.pipeworks.getState().simulationTimeMs > 400);
  await page.keyboard.press('Space');
  check(await page.evaluate(() => window.pipeworks.getState().bird.vy < -230), 'Space flaps during real gameplay');
  await page.keyboard.press('p');
  const time = await page.evaluate(() => window.pipeworks.getState().simulationTimeMs);
  await page.waitForTimeout(180);
  check(await page.evaluate(t => window.pipeworks.getState().paused && window.pipeworks.getState().simulationTimeMs === t, time), 'Pause freezes physics');
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.pipeworks.getState().phase === 'over');
  check(await page.getByRole('button', { name: 'One more flight' }).isVisible(), 'Collision shows retry');
  await page.getByRole('button', { name: 'One more flight' }).click();
  check(await page.evaluate(() => window.pipeworks.getState().phase === 'playing' && window.pipeworks.getState().score === 0), 'Retry resets and starts a new flight');
  await page.getByRole('button', { name: 'Restart game' }).click();
  await page.getByRole('button', { name: 'Auto JEV' }).click();
  check(await page.getByRole('dialog').isVisible(), 'Auto opens key entry');
  check(await page.locator('#api-key').getAttribute('type') === 'password', 'Key field is masked');
  check(await page.evaluate(() => window.pipeworks.getState().mode === 'manual'), 'No Auto mode without a key');
  await page.route('**/api/decision', async route => {
    if (route.request().headers().authorization === 'Bearer invalid-key') {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'That API key was not accepted.' }) });
      return;
    }
    const { state } = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      action: 'FLAP', probabilities: { FLAP: 0.9, WAIT: 0.1 }, confidence: 0.8,
      arrivalChoices: state.arrivalCases?.map(c => ({ id: c.id, action: 'FLAP',
        probabilities: { FLAP: 0.9, WAIT: 0.1 }, confidence: 0.8 })),
      model: 'jev-1.13.0', runId: state.runId, frameId: state.frameId,
    }) });
  });
  await page.getByLabel('Your TypeSafe API key').fill('invalid-key');
  await page.getByRole('button', { name: 'Connect Auto' }).click();
  await page.locator('#key-error').waitFor({ state: 'visible' });
  check(await page.locator('#key-error').textContent() === 'That API key was not accepted.', 'Invalid keys show an actionable error');
  await page.getByLabel('Your TypeSafe API key').fill('browser-smoke-key');
  await page.getByRole('button', { name: 'Connect Auto' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  check(await page.locator('#api-key').inputValue() === '', 'Connected key is removed from the DOM field');
  await page.getByRole('button', { name: 'Let Jev fly' }).click();
  await page.waitForFunction(() => Number(document.getElementById('decision-count').textContent) > 0);
  check(await page.evaluate(() => window.pipeworks.getState().mode === 'auto'), 'Auto applies decisions during a flight');
  check(await page.locator('#flap-percent').textContent() === '90%', 'Decision probabilities render');
  check(await page.evaluate(() => !JSON.stringify(localStorage).includes('browser-smoke-key') && !JSON.stringify(sessionStorage).includes('browser-smoke-key')), 'API key is not persisted to browser storage');
  await page.getByRole('button', { name: 'Under the wing' }).click();
  await page.waitForFunction(() => document.getElementById('state-output').textContent.includes('atExpectedArrival'));
  check(!(await page.locator('#state-output').textContent()).includes('browser-smoke-key'), 'State inspector excludes credentials');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  check(await page.evaluate(() => window.pipeworks.getState().mode === 'manual' && window.pipeworks.getState().phase === 'ready'), 'Disconnect returns control and resets');
  await page.unroute('**/api/decision');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => window.pipeworks?.getState().phase === 'ready');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile layout has no horizontal overflow');
  await page.getByRole('button', { name: 'Let’s fly', exact: true }).click();
  await page.locator('#game').click({ position: { x: 80, y: 170 } });
  check(await page.evaluate(() => window.pipeworks.getState().phase === 'playing'), 'Mobile pointer input plays the game');
  await page.getByRole('button', { name: 'Restart game' }).click();
  await page.waitForResponse(r => r.url().endsWith('/api/telemetry') && r.ok());
  check(flightEvents.some(e => e.event === 'run_end' && e.reason === 'water'), 'Crash state is sent to the dev server');
  check(flightEvents.some(e => e.event === 'action_applied' && e.selectedCaseId && e.before?.bird && e.after?.bird), 'Auto telemetry includes chosen arrival case and before/after states');
  check(!JSON.stringify(flightEvents).includes('browser-smoke-key'), 'Flight telemetry excludes the API key');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.playwright-cli/mobile.png', fullPage: true });
  check(errors.length === 0, `No browser exceptions (${errors.join(', ')})`);
  return { checks, passed: checks.length };
}
