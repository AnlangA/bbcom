import { createApp } from 'vue';
import { createPinia } from 'pinia';
import '../styles/global.css';
import { helper } from '@/lib/helper';

const Root = (await import('../App.vue')).default;
const app = createApp(Root);
app.use(createPinia());
const alpha = await import('../features/alpha');
void alpha;
void helper;
app.mount('#app');
