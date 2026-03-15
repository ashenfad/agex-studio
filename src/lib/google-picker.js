/**
 * Google Drive Picker integration.
 *
 * Loads the Google Picker API and opens a file picker dialog.
 * Selected files are tracked in localStorage and exposed via a
 * Svelte-compatible store.
 */

const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY || "";

const PICKED_STORAGE_KEY = "agex-google-picked-files";

/** @type {boolean} */
let pickerApiLoaded = false;

/**
 * @typedef {Object} PickedFile
 * @property {string} id - Google Drive file ID
 * @property {string} name - File name
 * @property {string} mimeType - MIME type
 */

// ---------------------------------------------------------------------------
// Picked files store (persisted to localStorage)
// ---------------------------------------------------------------------------

/** @type {((files: PickedFile[]) => void)[]} */
let subscribers = [];

/** @type {PickedFile[]} */
let pickedFiles = loadPickedFiles();

function loadPickedFiles() {
    try {
        const raw = localStorage.getItem(PICKED_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch {}
    return [];
}

function savePickedFiles() {
    localStorage.setItem(PICKED_STORAGE_KEY, JSON.stringify(pickedFiles));
}

function notify() {
    for (const fn of subscribers) fn(pickedFiles);
}

/** Svelte-compatible store for picked files. */
export const pickedFilesStore = {
    subscribe(fn) {
        subscribers.push(fn);
        fn(pickedFiles);
        return () => {
            subscribers = subscribers.filter((s) => s !== fn);
        };
    },
};

/**
 * Add files to the picked list (deduplicates by ID).
 * @param {PickedFile[]} files
 */
export function addPickedFiles(files) {
    const existing = new Set(pickedFiles.map((f) => f.id));
    const newFiles = files.filter((f) => !existing.has(f.id));
    if (newFiles.length === 0) return;
    pickedFiles = [...pickedFiles, ...newFiles];
    savePickedFiles();
    notify();
}

/**
 * Remove files from the picked list by ID.
 * @param {string[]} ids
 */
export function removePickedFiles(ids) {
    const removeSet = new Set(ids);
    pickedFiles = pickedFiles.filter((f) => !removeSet.has(f.id));
    savePickedFiles();
    notify();
}

/**
 * Clear all picked files.
 */
export function clearPickedFiles() {
    pickedFiles = [];
    savePickedFiles();
    notify();
}

// ---------------------------------------------------------------------------
// Picker API loading and invocation
// ---------------------------------------------------------------------------

/**
 * Whether the picker is available (API key configured).
 * @returns {boolean}
 */
export function isPickerAvailable() {
    return API_KEY.length > 0;
}

/**
 * Load the Google API script and Picker library.
 * @returns {Promise<void>}
 */
function loadPickerApi() {
    if (pickerApiLoaded) return Promise.resolve();

    return new Promise((resolve, reject) => {
        // Check if gapi is already loaded
        if (window.gapi) {
            window.gapi.load("picker", {
                callback: () => {
                    pickerApiLoaded = true;
                    resolve();
                },
            });
            return;
        }

        const script = document.createElement("script");
        script.src = "https://apis.google.com/js/api.js";
        script.async = true;
        script.onload = () => {
            window.gapi.load("picker", {
                callback: () => {
                    pickerApiLoaded = true;
                    resolve();
                },
            });
        };
        script.onerror = () => reject(new Error("Failed to load Google Picker API"));
        document.head.appendChild(script);
    });
}

/**
 * Open the Google Drive Picker.
 *
 * @param {string} token - Google OAuth access token
 * @returns {Promise<PickedFile[]>} Selected files (empty if cancelled)
 */
export async function openPicker(token) {
    if (!API_KEY) {
        throw new Error("VITE_GOOGLE_API_KEY not configured");
    }

    await loadPickerApi();

    return new Promise((resolve) => {
        const docsView = new google.picker.DocsView()
            .setIncludeFolders(false)
            .setSelectFolderEnabled(false);

        const picker = new google.picker.PickerBuilder()
            .addView(docsView)
            .setOAuthToken(token)
            .setDeveloperKey(API_KEY)
            .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
            .setCallback((data) => {
                if (data.action === google.picker.Action.PICKED) {
                    const files = data.docs.map((doc) => ({
                        id: doc.id,
                        name: doc.name,
                        mimeType: doc.mimeType,
                    }));
                    addPickedFiles(files);
                    resolve(files);
                } else if (data.action === google.picker.Action.CANCEL) {
                    resolve([]);
                }
            })
            .build();

        picker.setVisible(true);
    });
}
