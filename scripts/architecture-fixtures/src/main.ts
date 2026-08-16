import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/global.css';

const Root = (await import('./App.vue')).default;
const app = createApp(Root);
app.use(createPinia());
const alpha = await import('./features/alpha');
const beta = await import('./features/beta');
const deep = await import('./features/beta/internal');
const store = await import('./stores/app');
void alpha;
void beta;
void deep;
void store;
app.mount('#app');
