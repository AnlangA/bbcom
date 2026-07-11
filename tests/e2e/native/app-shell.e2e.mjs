import { browser, expect, $ } from '@wdio/globals';

describe('main window native smoke', () => {
  it('launches the signed application shell', async () => {
    await browser.pause(500);
    await expect($('body')).toBeDisplayed();
    await expect($('.app-layout')).toBeDisplayed();
  });
});
