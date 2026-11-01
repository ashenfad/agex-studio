/**
 * The site-filter extension's fixed ids: an unpacked copy's id comes from
 * the public key its manifest carries, so each build that loads unpacked
 * has one of its own. No private key is needed for either, nor kept.
 */

/** The dev build's id, from `extensions/filters/dev-key.pub`. */
export const DEV_FILTERS_ID = "ngjmgbacljndefdfpjogmfoominpdkaa";

/** The id of the build the studio's site offers for download, from
 *  `extensions/filters/site-key.pub`. */
export const SITE_FILTERS_ID = "knojdchlclobdfbmhcjkgdbpnlomigdb";
