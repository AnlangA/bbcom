import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import AiWindow from "./AiWindow.vue";
import "./styles/variables.css";
import "./styles/global.css";

const params = new URLSearchParams(window.location.search);
const isAiWindow = params.get("window") === "ai";
const app = createApp(isAiWindow ? AiWindow : App);
app.use(createPinia());
app.mount("#app");
