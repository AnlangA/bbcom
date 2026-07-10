import { browser, expect, $ } from '@wdio/globals';

describe('main window in browser mock mode', () => {
  it('boots the renderer without a native binary', async () => {
    await browser.url('/');
    await expect($('body')).toBeDisplayed();
    // Chrome's headless compositor may report the full-viewport flex root as
    // non-displayed even after Vue has mounted it. Existence is the stable
    // renderer-bootstrap assertion; interactive visibility is covered by
    // native WebDriver smoke jobs.
    await expect($('.app-layout')).toExist();
  });
});
