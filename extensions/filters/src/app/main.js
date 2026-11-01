/**
 * The extension's own page: the person's model and key, and the sites
 * the agent has worked on. Built with Vite, as the studio is, since it
 * reuses the studio's model settings (`src/lib/ModelSettings.svelte`)
 * and its styles.
 */

import { mount } from "svelte";
import "../../../../src/app.css";
import App from "./App.svelte";

mount(App, { target: /** @type {HTMLElement} */ (document.getElementById("app")) });
