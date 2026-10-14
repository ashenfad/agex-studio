import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'

const app = mount(App, { target: /** @type {HTMLElement} */ (document.getElementById('app')) })

export default app
