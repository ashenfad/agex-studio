/**
 * The pages the outline bench reads (`capture.mjs`, `compare.mjs`):
 * public pages only, none signed in. Each has the checks a good read of
 * it passes, as patterns searched for in the read's text: what an agent
 * needs to find there to get on with a task.
 *
 * Stays are for December 3 to 6, 2026, two adults; flights for February
 * 17 to 24, 2027. A site that changes its links, or refuses a headless
 * browser, captures as whatever it showed: the compare says so.
 *
 * @typedef {{ name: string, match: RegExp }} Check
 * @typedef {{ name: string, group: string, url: string, checks: Check[] }} Site
 */

/** A control of one of `kinds` whose name says `words`. @param {string} kinds @param {string} words */
const control = (kinds, words) => new RegExp(`\\] (${kinds}) "[^"\\n]*(${words})`, "i");
const field = (words) => control("textbox|searchbox|combobox|input|select", words);
const button = (words) => control("button|link|combobox", words);
/** Text on the page, anywhere. @param {string} source */
const text = (source) => new RegExp(source, "im");
const price = text("[$€£]\\s?\\d");

/** @type {Site[]} */
export const SITES = [
    // fixtures of the extension's own tests, served locally
    { name: "form", group: "fixtures", url: "fixture:form.html", checks: [
        { name: "the combobox's own field", match: field("Type a place|Course search") },
        { name: "the select's options", match: text("1 \\| 2 \\| 3|option \"2\"") },
    ] },
    { name: "consent", group: "fixtures", url: "fixture:consent.html", checks: [
        { name: "the page's rooms", match: text("Ocean view king") },
        { name: "the notice's accept", match: button("Accept") },
    ] },

    // hotels and stays
    { name: "booking", group: "stays", url: "https://www.booking.com/searchresults.html?ss=Lisbon&checkin=2026-12-03&checkout=2026-12-06&group_adults=2&no_rooms=1", checks: [
        { name: "the destination field", match: field("destination|where|own words") },
        { name: "the dates", match: button("dates|Dec 3|check-in") },
        { name: "a price", match: price },
    ] },
    { name: "expedia", group: "stays", url: "https://www.expedia.com/Hotel-Search?destination=Lisbon%2C%20Portugal&startDate=2026-12-03&endDate=2026-12-06&adults=2", checks: [
        { name: "the destination field", match: field("going to|destination|where") },
        { name: "the dates", match: button("dates|Dec 3") },
        { name: "a price", match: price },
    ] },
    { name: "airbnb", group: "stays", url: "https://www.airbnb.com/s/Lisbon--Portugal/homes?checkin=2026-12-03&checkout=2026-12-06&adults=2", checks: [
        { name: "the location field", match: field("where|location|destination") },
        { name: "a listing", match: button("Lisbon|apartment|home|room|loft") },
        { name: "a price", match: price },
    ] },
    { name: "marriott", group: "stays", url: "https://www.marriott.com/search/findHotels.mi?destinationAddress.destination=Lisbon%2C%20Portugal&fromDate=12%2F03%2F2026&toDate=12%2F06%2F2026&numberOfRooms=1&numAdultsPerRoom=2", checks: [
        { name: "a hotel", match: text("Lisbon|Lisboa") },
        { name: "a price", match: price },
    ] },
    { name: "hilton", group: "stays", url: "https://www.hilton.com/en/search/?query=Lisbon%2C%20Portugal&arrivalDate=2026-12-03&departureDate=2026-12-06&numRooms=1&numAdults=2", checks: [
        { name: "a hotel", match: text("Lisbon|Lisboa") },
        { name: "a price", match: price },
    ] },
    { name: "hyatt", group: "stays", url: "https://www.hyatt.com/search/hotels/en-US/Lisbon,%20Portugal?checkinDate=2026-12-03&checkoutDate=2026-12-06&rooms=1&adults=2", checks: [
        { name: "a hotel", match: text("Lisbon|Lisboa") },
        { name: "a price", match: price },
    ] },
    { name: "ihg", group: "stays", url: "https://www.ihg.com/hotels/us/en/find-hotels/hotel-search?qDest=Lisbon,%20Portugal&qCiD=03&qCiMy=112026&qCoD=06&qCoMy=112026&qAdlt=2&qRms=1", checks: [
        { name: "a hotel", match: text("Lisbon|Lisboa") },
        { name: "the dates", match: text("Dec|12/03") },
    ] },
    { name: "buccaneer", group: "stays", url: "https://www.thebuccaneer.com/", checks: [
        { name: "a way to book", match: button("book|reserve|availability") },
        { name: "the rooms", match: text("room|suite") },
    ] },

    // flights
    { name: "gflights", group: "flights", url: "https://www.google.com/travel/flights?q=Flights%20to%20STX%20from%20PDX%20on%202027-02-17%20through%202027-02-24", checks: [
        { name: "where from", match: field("where from|from") },
        { name: "the departure date", match: field("departure") },
        { name: "a fare", match: price },
    ] },
    { name: "kayak", group: "flights", url: "https://www.kayak.com/flights/PDX-STX/2027-02-17/2027-02-24", checks: [
        { name: "a fare", match: price },
        { name: "an airline", match: text("Alaska|Delta|American|United|JetBlue") },
    ] },
    { name: "alaska", group: "flights", url: "https://www.alaskaair.com/", checks: [
        { name: "where from", match: field("from|origin|depart") },
        { name: "the dates", match: control("textbox|button|combobox", "date|depart") },
    ] },

    // maps and places
    { name: "udisc", group: "places", url: "https://udisc.com/courses", checks: [
        { name: "the location search", match: field("location|search") },
        { name: "a course", match: text("Disc Golf|DGC|Park") },
    ] },
    { name: "dgcr", group: "places", url: "https://www.dgcoursereview.com/courses", checks: [
        { name: "a course", match: text("Park|Course|DGC") },
        { name: "the search", match: field("search|location|zip") },
    ] },
    { name: "gmaps", group: "places", url: "https://www.google.com/maps/search/disc+golf+course+Corvallis+OR", checks: [
        { name: "the directions", match: button("directions") },
        { name: "a place", match: text("Disc Golf|Park") },
    ] },
    { name: "yelp", group: "places", url: "https://www.yelp.com/search?find_desc=coffee&find_loc=Corvallis%2C+OR", checks: [
        { name: "a business", match: text("Coffee|Cafe|Café") },
        { name: "the search", match: field("find|search|near") },
    ] },

    // shopping
    { name: "amazon", group: "shopping", url: "https://www.amazon.com/s?k=disc+golf+discs", checks: [
        { name: "a product", match: text("Disc") },
        { name: "a price", match: price },
    ] },
    { name: "allbirds", group: "shopping", url: "https://www.allbirds.com/collections/mens", checks: [
        { name: "a product", match: text("Runner|Dasher|Tree|Wool") },
        { name: "a price", match: price },
    ] },
    { name: "etsy", group: "shopping", url: "https://www.etsy.com/search?q=disc+golf", checks: [
        { name: "a listing", match: text("Disc") },
        { name: "a price", match: price },
    ] },

    // reservations
    { name: "opentable", group: "reservations", url: "https://www.opentable.com/s?covers=2&dateTime=2026-12-03T19%3A00&term=Portland", checks: [
        { name: "a restaurant", match: text("Portland|Restaurant") },
        { name: "a time slot", match: button("\\d{1,2}:\\d{2}") },
    ] },

    // content
    { name: "wikipedia", group: "content", url: "https://en.wikipedia.org/wiki/Disc_golf", checks: [
        { name: "the article", match: text("flying disc sport") },
        { name: "its sections", match: text("^#+ (History|Equipment)") },
    ] },
    { name: "github", group: "content", url: "https://github.com/microsoft/playwright-mcp", checks: [
        { name: "the readme", match: text("Playwright MCP") },
        { name: "the files", match: control("link|row|gridcell", "README|package.json|src") },
    ] },
    { name: "bbc", group: "content", url: "https://www.bbc.com/news", checks: [
        { name: "a headline", match: control("link|heading", "\\w+ \\w+ \\w+") },
    ] },
    { name: "reddit", group: "content", url: "https://www.reddit.com/r/discgolf/", checks: [
        { name: "a post", match: control("link|article|heading", "\\w+ \\w+") },
        { name: "the subreddit", match: text("discgolf") },
    ] },
];
