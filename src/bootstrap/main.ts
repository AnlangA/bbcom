import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { settingsService } from '@/features/settings';
import { bootstrapApplication } from './bootstrap-application';
import '@/design-system/tokens/index.css';
import '@/styles/global.css';
import '@/styles/packet-columns.css';
import '@/styles/ansi-packet.css';

settingsService.hydrate();

const params = new URLSearchParams(window.location.search);
const isAiWindow = params.get('window') === 'ai';

const RootComponent = isAiWindow
  ? (await import('../AiWindow.vue')).default
  : (await import('../App.vue')).default;

const app = createApp(RootComponent);
const pinia = createPinia();
app.use(pinia);

if (!isAiWindow) {
  await bootstrapApplication(app, pinia);
}

app.mount('#app');
