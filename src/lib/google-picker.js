/**
 * Google Drive Picker integration.
 *
 * Loads the Google Picker API and opens a file picker dialog.
 * Picked file persistence is handled by sessions.js (kvgit state).
 */

const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY || "";
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
// App ID is the Cloud project number (numeric prefix of the client ID)
const APP_ID = CLIENT_ID.split("-")[0] || "";

/** @type {boolean} */
let pickerApiLoaded = false;

/**
 * @typedef {Object} PickedFile
 * @property {string} id - Google Drive file ID
 * @property {string} name - File name
 * @property {string} mimeType - MIME type
 */

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

        const builder = new google.picker.PickerBuilder()
            .addView(docsView)
            .setOAuthToken(token)
            .setDeveloperKey(API_KEY)
            .enableFeature(google.picker.Feature.MULTISELECT_ENABLED);

        if (APP_ID) builder.setAppId(APP_ID);

        const picker = builder
            .setCallback((data) => {
                if (data.action === google.picker.Action.PICKED) {
                    const files = data.docs.map((doc) => ({
                        id: doc.id,
                        name: doc.name,
                        mimeType: doc.mimeType,
                    }));
                    resolve(files);
                } else if (data.action === google.picker.Action.CANCEL) {
                    resolve([]);
                }
            })
            .build();

        picker.setVisible(true);
    });
}
