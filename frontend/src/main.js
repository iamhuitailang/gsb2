import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import RulesView from './views/RulesView.vue'
import RunsView from './views/RunsView.vue'
import RunDetailView from './views/RunDetailView.vue'
import PagesView from './views/PagesView.vue'
import DiffView from './views/DiffView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/rules' },
    { path: '/rules', component: RulesView },
    { path: '/runs', component: RunsView },
    { path: '/runs/:id', component: RunDetailView },
    { path: '/pages', component: PagesView },
    { path: '/diff', component: DiffView },
  ],
})

createApp(App).use(router).mount('#app')
