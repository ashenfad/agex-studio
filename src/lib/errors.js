/**
 * What went wrong, as text: an error's message, or anything else thrown
 * as a string.
 *
 * @param {unknown} e
 * @returns {string}
 */
export function errorText(e) {
    return e instanceof Error ? e.message : String(e);
}
