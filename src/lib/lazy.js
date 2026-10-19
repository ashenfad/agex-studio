/**
 * What the chat draws only once it comes near the view: its charts,
 * diagrams, images and tables, which cost far more to draw than text,
 * and in a long session are mostly far out of sight. A placeholder of
 * about their size holds their place until then.
 *
 * One `Nearby` per chat watches them all: it says when one comes within
 * `MARGIN` of the scrolled view (drawn a little ahead, so a reader
 * scrolling seldom sees a placeholder), and when one drawn above the
 * view changes size, which would move what the reader is looking at.
 *
 * A new kind of embed gets the same by being wrapped in `Deferred` with
 * its placeholder's height.
 */

import { getContext, setContext } from "svelte";

/** How far outside the view, in pixels, an embed starts drawing. */
const MARGIN = 1500;

const KEY = Symbol("nearby");

/** Heights drawn embeds came out at, by their key, so one drawn again
 *  (the session reopened) holds exactly its place. */
const heights = new Map();
const HEIGHTS_MAX = 2000;

/** A drawn embed's height, kept under `key`.
 *  @param {string} key @param {number} height */
export function rememberHeight(key, height) {
    heights.delete(key);
    heights.set(key, height);
    if (heights.size > HEIGHTS_MAX) heights.delete(heights.keys().next().value);
}

/** The height an embed under `key` came out at, if it was drawn.
 *  @param {string} key @returns {number | undefined} */
export function knownHeight(key) {
    return heights.get(key);
}

/**
 * The embeds of one scrolled list.
 */
export class Nearby {
    /** @type {IntersectionObserver} */
    #near;
    /** @type {ResizeObserver} */
    #sizes;
    /** @type {Map<Element, () => void>} */
    #waiting = new Map();
    /** @type {WeakMap<Element, number>} */
    #last = new WeakMap();

    /**
     * @param {HTMLElement} root the scrolled list
     * @param {(node: Element, delta: number) => void} onResize a watched
     *   node changed height by `delta`
     */
    constructor(root, onResize) {
        this.#near = new IntersectionObserver(
            (entries) => {
                for (const e of entries) {
                    if (!e.isIntersecting) continue;
                    const fn = this.#waiting.get(e.target);
                    this.#waiting.delete(e.target);
                    this.#near.unobserve(e.target);
                    fn?.();
                }
            },
            { root, rootMargin: `${MARGIN}px 0px` },
        );
        this.#sizes = new ResizeObserver((entries) => {
            for (const e of entries) {
                const height = e.borderBoxSize?.[0]?.blockSize ?? e.target.getBoundingClientRect().height;
                const before = this.#last.get(e.target);
                this.#last.set(e.target, height);
                if (before !== undefined && height !== before) onResize(e.target, height - before);
            }
        });
    }

    /** `fn`, once, when `node` comes near the view; undone by the
     *  function returned. @param {Element} node @param {() => void} fn */
    whenNear(node, fn) {
        this.#waiting.set(node, fn);
        this.#near.observe(node);
        return () => {
            this.#waiting.delete(node);
            this.#near.unobserve(node);
        };
    }

    /** Report `node`'s changes of height; undone by the function
     *  returned. @param {Element} node */
    watchSize(node) {
        this.#sizes.observe(node);
        return () => {
            this.#sizes.unobserve(node);
            this.#last.delete(node);
        };
    }

    disconnect() {
        this.#near.disconnect();
        this.#sizes.disconnect();
        this.#waiting.clear();
    }
}

/** Make the chat's `Nearby` the one the components below it use: read
 *  through `get`, as the chat makes it once its list is in the page.
 *  @param {() => Nearby | null} get */
export function provideNearby(get) {
    setContext(KEY, get);
}

/** The chat's `Nearby`, from a component inside it (called as it
 *  starts): a function reading it (null until the chat has made it), or
 *  null outside a chat, where everything draws at once.
 *  @returns {(() => Nearby | null) | null} */
export function useNearby() {
    return getContext(KEY) ?? null;
}
