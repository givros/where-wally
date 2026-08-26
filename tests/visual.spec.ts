import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { PNG } from 'pngjs';

type CanvasSample = {
  ok: boolean;
  reason: string;
  variance?: number;
  colorBuckets?: number;
};

type ErrorCapture = {
  consoleErrors: string[];
  pageErrors: string[];
};

function captureErrors(page: Page): ErrorCapture {
  const capture: ErrorCapture = { consoleErrors: [], pageErrors: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') capture.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => capture.pageErrors.push(error.message));
  return capture;
}

async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const diagnostics = window.__THREE_GAME_DIAGNOSTICS__;
    return diagnostics?.wally.ready === true &&
      diagnostics.crowd.assetLoaded === true &&
      diagnostics.state === 'ready';
  });
  await expect(page.locator('#start-button')).toBeEnabled();
}

async function sampleCanvas(page: Page): Promise<CanvasSample> {
  const canvas = page.locator('#game-canvas');
  const box = await canvas.boundingBox();
  if (!box || box.width < 32 || box.height < 32) {
    return { ok: false, reason: 'canvas-too-small' };
  }

  const buffer = await canvas.screenshot();
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  let alphaPixels = 0;
  const buckets = new Set<string>();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 6_000));

  for (let pixel = 0; pixel < png.width * png.height; pixel += stride) {
    const offset = pixel * 4;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    min = Math.min(min, r, g, b);
    max = Math.max(max, r, g, b);
    if (a > 0) alphaPixels += 1;
    buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
  }

  const variance = max - min;
  return {
    ok: alphaPixels > 512 && variance > 18 && buckets.size > 12,
    reason: 'sampled',
    variance,
    colorBuckets: buckets.size,
  };
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(name, { body: screenshot, contentType: 'image/png' });
}

test('10,000-person CharacterBase search supports movement, penalty, pause, find, and restart', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chrome', 'Desktop gameplay coverage.');
  const errors = captureErrors(page);
  await page.goto('/?crowd=10000&seed=7331');
  await expect(page.locator('#game-canvas')).toBeVisible();
  await waitForReady(page);
  await expect(page.locator('#target-dossier')).toBeVisible();
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.wally)).toMatchObject({
    loaded: true,
    fallback: false,
    animation: 'Idle',
    meshCount: 3,
    triangles: 5_622,
  });
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.crowd)).toMatchObject({
    source: 'blender-characterbase',
    oneCanonicalBase: true,
    fullGeometryOnly: true,
    completeCharacterBaseCharacters: 10_000,
    simplifiedCharacters: 0,
    assetLoaded: true,
    activeHighCharacters: 512,
    activeMediumCharacters: 0,
    activeLowCharacters: 0,
    stripedCharacters: 10_000,
    collidableCharacters: 10_000,
    pushableCharacters: 10_000,
    wallyLikeCharacters: 0,
    exactWallyOutfits: 0,
    outfitVariants: 10_000,
    uniqueOutfitSignatures: 10_000,
    perceptuallyUniqueOutfits: 10_000,
    visibleExtraElements: 0,
    renderMode: 'pooled-visible-complete-characterbase-high',
    activeInstancedMeshes: 3,
    uniqueMaterials: 3,
    drawCallEstimate: 3,
    renderPoolCapacity: 512,
    visibleCharacters: 512,
    culledCharacters: 9_488,
    renderPartInstances: 1_536,
    approximateTriangles: 2_878_464,
  });
  const initialOutfitHash = String(
    await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.crowd.outfitSignatureHash),
  );

  const initialSample = await sampleCanvas(page);
  expect(initialSample, JSON.stringify(initialSample)).toMatchObject({ ok: true });
  await page.locator('#start-button').click();
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('playing');

  const pushTarget = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.setupCrowdPush());
  await expect
    .poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.aimAura))
    .toMatchObject({
      visible: true,
      targetKind: 'crowd',
      crowdIndex: pushTarget.characterIndex,
      sameAppearanceForEveryPerson: true,
      style: 'white-body-silhouette',
      color: '#ffffff',
      bodyHighlight: true,
      proceduralRings: 0,
      crowdHighlightMeshes: 6,
    });
  await page.keyboard.down('KeyW');
  await expect
    .poll(async () => {
      const current = await page.evaluate(
        (characterIndex) => window.__THREE_GAME_TEST_HOOKS__!.readCrowdCharacter(characterIndex),
        pushTarget.characterIndex,
      );
      return Math.hypot(current.x - pushTarget.x, current.z - pushTarget.z);
    }, { timeout: 20_000 })
    .toBeGreaterThan(0.05);
  await page.keyboard.up('KeyW');
  const pushedTarget = await page.evaluate(
    (characterIndex) => window.__THREE_GAME_TEST_HOOKS__!.readCrowdCharacter(characterIndex),
    pushTarget.characterIndex,
  );
  expect(Math.hypot(pushedTarget.x - pushTarget.x, pushedTarget.z - pushTarget.z)).toBeGreaterThan(0.05);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.triggerIdentify('wrong'));
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.game.wrongGuesses)).toBe(1);
  expect(await page.locator('#penalty-value').textContent()).toContain('+5s');

  await page.keyboard.press('KeyP');
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('paused');
  await expect
    .poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.aimAura.visible))
    .toBe(false);
  await page.keyboard.press('KeyP');
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('playing');

  await page.keyboard.press('KeyM');
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.audio.muted)).toBe(true);
  await page.keyboard.press('KeyM');
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.audio.muted)).toBe(false);

  const firstSpot = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.findWally());
  await expect
    .poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.aimAura))
    .toMatchObject({
      visible: true,
      targetKind: 'wally',
      crowdIndex: null,
      sameAppearanceForEveryPerson: true,
      style: 'white-body-silhouette',
      color: '#ffffff',
      bodyHighlight: true,
      proceduralRings: 0,
      wallyHighlightMeshes: 6,
    });
  await attachScreenshot(page, testInfo, 'wally-white-body-highlight.png');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.identifyReticle());
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('won');
  await expect
    .poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.aimAura.visible))
    .toBe(false);
  await expect(page.locator('#success-overlay')).toBeVisible();
  await attachScreenshot(page, testInfo, '10000-person-success.png');

  await page.keyboard.press('KeyR');
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('playing');
  const secondSpot = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.wally.position);
  expect(Math.hypot(secondSpot.x - firstSpot.x, secondSpot.z - firstSpot.z)).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.game.wrongGuesses)).toBe(0);
  expect(Number(await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!.crowd.pushEvents))).toBe(0);
  const restartedWardrobe = await page.evaluate(() => ({
    hash: String(window.__THREE_GAME_DIAGNOSTICS__!.crowd.outfitSignatureHash),
    unique: Number(window.__THREE_GAME_DIAGNOSTICS__!.crowd.uniqueOutfitSignatures),
    exactWally: Number(window.__THREE_GAME_DIAGNOSTICS__!.crowd.exactWallyOutfits),
  }));
  expect(restartedWardrobe.hash).not.toBe(initialOutfitHash);
  expect(restartedWardrobe.unique).toBe(10_000);
  expect(restartedWardrobe.exactWally).toBe(0);

  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});

test('10,000-person search fits mobile portrait and completes with touch UI', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chrome', 'Mobile responsive coverage.');
  const errors = captureErrors(page);
  await page.goto('/?crowd=10000&seed=7331');
  await waitForReady(page);

  await expect(page.locator('#crowd-cluster')).toBeVisible();
  await expect(page.locator('#crowd-value')).toHaveText('10,000');
  await expect(page.locator('#target-dossier')).toBeVisible();
  const responsive = await page.evaluate(() => ({
    touchMode: window.__THREE_GAME_DIAGNOSTICS__!.input.mode,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    canvasWidth: document.querySelector('canvas')?.clientWidth ?? 0,
    viewportWidth: window.innerWidth,
  }));
  expect(responsive.touchMode).toBe('touch');
  expect(responsive.overflowX).toBeLessThanOrEqual(0);
  expect(responsive.canvasWidth).toBe(responsive.viewportWidth);

  const diagnostics = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__!);
  expect(diagnostics.game.crowdCount).toBe(10_000);
  expect(diagnostics.crowd).toMatchObject({
    source: 'blender-characterbase',
    oneCanonicalBase: true,
    fullGeometryOnly: true,
    completeCharacterBaseCharacters: 10_000,
    simplifiedCharacters: 0,
    collidableCharacters: 10_000,
    pushableCharacters: 10_000,
    outfitVariants: 10_000,
    uniqueOutfitSignatures: 10_000,
    perceptuallyUniqueOutfits: 10_000,
    exactWallyOutfits: 0,
    renderMode: 'pooled-visible-complete-characterbase-high',
    renderPoolCapacity: 256,
    visibleCharacters: 256,
    activeHighCharacters: 256,
    activeMediumCharacters: 0,
    activeLowCharacters: 0,
    activeInstancedMeshes: 3,
    drawCallEstimate: 3,
    renderPartInstances: 768,
    approximateTriangles: 1_439_232,
  });
  expect(Number(diagnostics.renderer.calls)).toBeLessThanOrEqual(40);
  expect(Number(diagnostics.renderer.triangles)).toBeLessThan(1_700_000);

  await page.locator('#start-button').click();
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('playing');
  await expect(page.locator('#mobile-controls')).toBeVisible();
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__!.findWally());
  await expect
    .poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.aimAura.targetKind))
    .toBe('wally');
  await attachScreenshot(page, testInfo, '10000-person-mobile-target.png');
  await page.locator('#identify-touch').click();
  await expect.poll(() => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.state)).toBe('won');
  await expect(page.locator('#success-overlay')).toBeVisible();

  expect(errors.consoleErrors).toEqual([]);
  expect(errors.pageErrors).toEqual([]);
});
