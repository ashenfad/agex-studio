/**
 * Where a reader is in a scrolled list, kept across a change of its
 * width: when the list narrows or widens, its text rewraps and every
 * row's height changes, so the same scroll offset shows something else.
 * What was at the top of the view is noted, as deep as the markup goes,
 * and brought back to the top after.
 */

/**
 * @typedef {{ node: Element, below: number } | { node: Element, into: number }} Reading
 * `below`: the node starts this many pixels under the view's top.
 * `into`: the view's top is this share of the way down the node, a
 * share rather than pixels so a paragraph that rewraps keeps its place.
 */

/**
 * The deepest element at the top of `list`'s view, and where the top
 * falls on it; null for an empty list.
 *
 * @param {HTMLElement} list
 * @returns {Reading | null}
 */
export function readingAt(list) {
    const top = list.getBoundingClientRect().top;
    /** @type {Element | null} */
    let node = null;
    let kids = list.children;
    for (let depth = 0; depth < 12; depth++) {
        /** @type {Element | null} */
        let hit = null;
        for (const kid of kids) {
            const box = kid.getBoundingClientRect();
            if (box.height > 0 && box.bottom > top) {
                hit = kid;
                break;
            }
        }
        if (hit === null) break;
        node = hit;
        const box = hit.getBoundingClientRect();
        if (box.top >= top || hit.children.length === 0) break;
        kids = hit.children;
    }
    if (node === null) return null;
    const box = node.getBoundingClientRect();
    return box.top >= top ? { node, below: box.top - top } : { node, into: (top - box.top) / box.height };
}

/**
 * Scroll `list` so `reading`'s node sits where it did at the top of the
 * view. Nothing, if the node has left the page.
 *
 * @param {HTMLElement} list
 * @param {Reading} reading
 */
export function keepReading(list, reading) {
    if (!reading.node.isConnected) return;
    const top = list.getBoundingClientRect().top;
    const box = reading.node.getBoundingClientRect();
    const want = "into" in reading ? top - reading.into * box.height : top + reading.below;
    list.scrollTop += box.top - want;
}
