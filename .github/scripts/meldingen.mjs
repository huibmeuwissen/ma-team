// Stuurt pushmeldingen voor verlopen taken van het MA Teamdashboard.
// Draait elke 5 minuten via GitHub Actions (.github/workflows/meldingen.yml).
// Let op: de logs van een openbare repository zijn openbaar, dus hier nooit teamcodes, namen of taakteksten loggen.
import admin from "firebase-admin";

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
// zonder geheim netjes stoppen (geen mislukte runs en foutmails zolang het geheim nog niet is ingesteld)
if (!sa.project_id) { console.log("Geheim FIREBASE_SERVICE_ACCOUNT is nog niet ingesteld; niets te doen."); process.exit(0); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const fcm = admin.messaging();

const nu = Date.now();
const WEEK = 7 * 24 * 60 * 60 * 1000;
let verstuurd = 0, taken = 0, opgeruimd = 0;

const teams = await db.collection("teams").listDocuments();
for (const team of teams) {
  const snap = await team.collection("taken").where("status", "==", "open").get();
  // verlopen, nog niet gemeld voor deze opvolgdatum, en niet ouder dan een week (geen stortvloed oude meldingen)
  const verlopen = snap.docs.filter(d => {
    const t = d.data();
    return typeof t.opvolgOp === "number" && t.opvolgOp <= nu && t.opvolgOp > nu - WEEK && t.gemeldVoor !== t.opvolgOp;
  });
  if (!verlopen.length) continue;

  const tokens = await team.collection("tokens").get();
  const perNaam = {};
  tokens.docs.forEach(d => { const n = d.data().naam; (perNaam[n] ||= []).push(d); });

  for (const d of verlopen) {
    const t = d.data();
    taken++;
    const wie = t.klantNaam || "";
    const title = wie ? `Heb je ${wie} nagebeld?` : "Taak opvolgen";
    const body = String(t.titel || "") + (t.door && t.door !== t.voor ? ` (van ${t.door})` : "");
    for (const tok of perNaam[t.voor] || []) {
      try {
        await fcm.send({
          token: tok.id,
          data: { title, body, tag: "taak-" + d.id, url: "./#taken" },
          webpush: { headers: { Urgency: "high", TTL: "86400" } }
        });
        verstuurd++;
      } catch (e) {
        const code = String(e.code || "");
        if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token") || code.includes("invalid-argument")) {
          await tok.ref.delete(); opgeruimd++;
        } else {
          console.error("Versturen mislukt:", code || e.message);
        }
      }
    }
    await d.ref.update({ gemeldVoor: t.opvolgOp });
  }
}
console.log(`Klaar: ${taken} verlopen taak/taken, ${verstuurd} melding(en) verstuurd, ${opgeruimd} verouderd(e) apparaat/apparaten opgeruimd.`);
