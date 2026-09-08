/**
 * @vitest-environment happy-dom
 */
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mount, type VueWrapper } from '@vue/test-utils';
import { t } from '@/lib/i18n';
import McumgrHoverTip from '@/features/terminal/ui/mcumgr/McumgrHoverTip.vue';
import McumgrImageTab from '@/features/terminal/ui/mcumgr/McumgrImageTab.vue';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';

function fakeMcumgr(overrides: Partial<SessionMcumgrController> = {}): SessionMcumgrController {
  return {
    execute: vi.fn(async () => null),
    pickFile: vi.fn(async () => null),
    firmwareUpdate: vi.fn(async () => null),
    imageUpload: vi.fn(async () => null),
    runImageTest: vi.fn(async () => null),
    runImageConfirm: vi.fn(async () => null),
    ...overrides,
  } as SessionMcumgrController;
}

function mountTab(
  props: {
    busy?: boolean;
    imageHash?: string;
    upgradeOnly?: boolean;
    mcumgr?: SessionMcumgrController;
  } = {},
): VueWrapper {
  return mount(McumgrImageTab, {
    props: {
      busy: props.busy ?? false,
      imageHash: props.imageHash ?? '',
      upgradeOnly: props.upgradeOnly ?? false,
      mcumgr: props.mcumgr ?? fakeMcumgr(),
    },
  });
}

function hintTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAllComponents(McumgrHoverTip).map((tip) => String(tip.props('text')));
}

function buttonByLabel(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll('button').find((node) => node.text().includes(label));
  assert.ok(button, `missing button labeled ${label}`);
  return button;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('image actions and the shared upgrade option remain discoverable', () => {
  const wrapper = mountTab();
  for (const key of [
    'mcumgr.image.update',
    'mcumgr.image.upload',
    'mcumgr.image.state',
    'mcumgr.image.slotInfo',
    'mcumgr.image.test',
    'mcumgr.image.confirm',
    'mcumgr.image.erase',
  ]) {
    buttonByLabel(wrapper, t(key));
  }
  assert.equal(wrapper.text().includes(t('mcumgr.image.upgradeOnly')), true);
  assert.equal(wrapper.find('[role="checkbox"]').exists(), true);
});

test('firmware upgrade is the primary action and image upload remains secondary', () => {
  const wrapper = mountTab();
  const upgrade = buttonByLabel(wrapper, t('mcumgr.image.update'));
  const upload = buttonByLabel(wrapper, t('mcumgr.image.upload'));
  assert.equal(upgrade.attributes('aria-label'), t('mcumgr.image.update'));
  assert.equal(upload.attributes('aria-label'), t('mcumgr.image.upload'));
  assert.equal(upgrade.classes().includes('transfer-action'), true);
  assert.equal(upload.classes().includes('transfer-action'), true);
  assert.equal(upgrade.classes().includes('is-primary'), true);
  assert.equal(upload.classes().includes('is-primary'), false);
  assert.equal(wrapper.text().includes(t('mcumgr.image.updateCaption')), true);
  assert.equal(wrapper.text().includes(t('mcumgr.image.uploadCaption')), true);
});

test('image actions, hash entry, and version protection retain their hover help', () => {
  const wrapper = mountTab();
  const hints = hintTexts(wrapper);
  for (const key of [
    'mcumgr.image.updateHint',
    'mcumgr.image.uploadHint',
    'mcumgr.image.upgradeOnlyHint',
    'mcumgr.image.stateHint',
    'mcumgr.image.slotInfoHint',
    'mcumgr.image.eraseHint',
    'mcumgr.image.hashHint',
    'mcumgr.image.testHint',
    'mcumgr.image.confirmHint',
  ]) {
    assert.equal(hints.includes(t(key)), true, `missing hover tip ${key}`);
  }
});

test('test boot stays disabled until a hash is present; confirm does not', async () => {
  const wrapper = mountTab({ imageHash: '' });
  assert.equal(
    buttonByLabel(wrapper, t('mcumgr.image.test')).attributes('disabled') !== undefined,
    true,
  );
  assert.equal(buttonByLabel(wrapper, t('mcumgr.image.confirm')).attributes('disabled'), undefined);

  await wrapper.setProps({ imageHash: 'aabbcc' });
  assert.equal(buttonByLabel(wrapper, t('mcumgr.image.test')).attributes('disabled'), undefined);
});

test('inspect and erase buttons dispatch the matching MCUmgr operations', async () => {
  const mcumgr = fakeMcumgr();
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
  const wrapper = mountTab({ mcumgr });

  await buttonByLabel(wrapper, t('mcumgr.image.state')).trigger('click');
  await buttonByLabel(wrapper, t('mcumgr.image.slotInfo')).trigger('click');
  await buttonByLabel(wrapper, t('mcumgr.image.erase')).trigger('click');

  assert.equal((mcumgr.execute as ReturnType<typeof vi.fn>).mock.calls.length, 3);
  assert.deepEqual((mcumgr.execute as ReturnType<typeof vi.fn>).mock.calls[0], [
    'image-state',
    { kind: 'image-state' },
  ]);
  assert.deepEqual((mcumgr.execute as ReturnType<typeof vi.fn>).mock.calls[1], [
    'slot-info',
    { kind: 'image-slot-info' },
  ]);
  assert.deepEqual((mcumgr.execute as ReturnType<typeof vi.fn>).mock.calls[2], [
    'image-erase',
    { kind: 'image-erase', slot: null },
  ]);
});

test('firmware upgrade confirms the slot and reboots; image upload does not', async () => {
  const mcumgr = fakeMcumgr({
    pickFile: vi.fn(async () => ({
      token: 'grant-1',
      displayName: 'app.bin',
      sizeBytes: 2048,
    })),
  });
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
  const wrapper = mountTab({ mcumgr, upgradeOnly: true });

  await buttonByLabel(wrapper, t('mcumgr.image.update')).trigger('click');
  await buttonByLabel(wrapper, t('mcumgr.image.upload')).trigger('click');

  assert.deepEqual((mcumgr.firmwareUpdate as ReturnType<typeof vi.fn>).mock.calls, [
    ['grant-1', { upgradeOnly: true, forceConfirm: true }],
  ]);
  assert.deepEqual((mcumgr.imageUpload as ReturnType<typeof vi.fn>).mock.calls, [
    ['grant-1', true],
  ]);
});
