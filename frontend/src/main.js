import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import SessionList from './views/SessionList.vue'
import SessionDetail from './views/SessionDetail.vue'
import './styles.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'list', component: SessionList },
    { path: '/sessions/:sessionId', name: 'session-detail', component: SessionDetail, props: true },
  ],
})

createApp(App).use(router).mount('#app')
