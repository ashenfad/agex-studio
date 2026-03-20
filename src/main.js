import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'

// Register service worker to cache PyPI wheel downloads
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
}

const app = mount(App, { target: document.getElementById('app') })
document.getElementById('static-footer')?.remove()

export default app
