import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/variables.css';
import './styles/global.css';

const params = new URLSearchParams(window.location.search);
const isAiWindow = params.get('window') === 'ai';

const RootComponent = isAiWindow
  ? (await import('./AiWindow.vue')).default
  : (await import('./App.vue')).default;

const app = createApp(RootComponent);
app.use(createPinia());
app.mount('#app');
