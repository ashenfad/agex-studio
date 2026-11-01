/** Whether this is the dev build: set by the build (esbuild's `define`). */
declare const __DEV__: boolean;

/** A Markdown file, as its text (esbuild's `text` loader). */
declare module "*.md" {
    const text: string;
    export default text;
}
