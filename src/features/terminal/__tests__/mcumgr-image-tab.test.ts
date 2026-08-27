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

test('image tab uses equal action tiles without an always-visible update blurb', () => {
  const wrapper = mountTab();
  const text = wrapper.text();
  assert.match(text, /固件升级/);
  assert.match(text, /镜像上传/);
  assert.match(text, /查看/);
  assert.match(text, /启动标记/);
  assert.equal(wrapper.findAll('.mc-card').length, 4);
  assert.equal(wrapper.findAll('.mc-action-tile').length, 2);
  assert.equal(wrapper.find('.mc-card-copy').exists(), false);
  assert.equal(text.includes(t('mcumgr.image.updateHint')), false);
  assert.equal(text.includes(t('mcumgr.image.uploadHint')), false);
  assert.equal(text.includes(t('mcumgr.image.updateCaption')), true);
  assert.equal(text.includes(t('mcumgr.image.uploadCaption')), true);
  assert.equal(text.includes('仅升级'), true);
  assert.equal(text.includes('拒绝旧版本'), false);
});

test('firmware actions use matching compact primary buttons', () => {
  const wrapper = mountTab();
  const upgrade = buttonByLabel(wrapper, t('mcumgr.image.update'));
  const upload = buttonByLabel(wrapper, t('mcumgr.image.upload'));
  const classOf = (node: ReturnType<typeof buttonByLabel>) => node.classes().join(' ');
  assert.match(classOf(upgrade), /tiny/);
  assert.match(classOf(upload), /tiny/);
  assert.match(classOf(upgrade), /primary/);
  assert.match(classOf(upload), /primary/);

  assert.equal(wrapper.find('.mc-action-content .mc-hover-tip-host.is-block').exists(), false);
  assert.equal(/block/.test(classOf(upgrade)), false);
  assert.equal(/block/.test(classOf(upload)), false);
});

test('every image action and section header exposes hover hint copy', () => {
  const wrapper = mountTab();
  const hints = hintTexts(wrapper);
  for (const key of [
    'mcumgr.group.inspectHint',
    'mcumgr.group.bootHint',
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
