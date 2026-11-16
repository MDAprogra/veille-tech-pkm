// Remet en file d'enrichissement les articles hérités de la v1 (sans thèmes ou sans score).
// Ils seront retraités par Mistral au fil des collectes (MAX_ENRICH_PER_RUN par collecte), sans notification.
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db/store.js";

const store = new Store(loadConfig().db.path);
console.log(`${store.requeueIncomplete()} article(s) remis en file d'enrichissement.`);
store.close();
