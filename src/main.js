import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import Docs from './lib/Docs.svelte'

const target = /** @type {HTMLElement} */ (document.getElementById('app'))
// `/docs/` is the help pages, without the studio behind them
const docs = location.pathname === '/docs' || location.pathname === '/docs/'
const app = docs ? mount(Docs, { target }) : mount(App, { target })

export default app
