// Cloud Function van het MA Teamdashboard: stuurt elke minuut pushmeldingen voor verlopen taken.
// Uitrollen: in de map "MA Teamdashboard website" -> firebase deploy --only functions
// Let op: logs nooit met teamcodes, namen of taakteksten vullen.
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const WEEK = 7 * 24 * 60 * 60 * 1000;

exports.meldingen = onSchedule(
  { schedule: "every 1 minutes", region: "europe-west1", timeZone: "Europe/Amsterdam", memory: "256MiB", timeoutSeconds: 60, retryCount: 0 },
  async () => {
    const db = getFirestore();
    const fcm = getMessaging();
    const nu = Date.now();
    let verstuurd = 0, taken = 0, opgeruimd = 0;

    const teams = await db.collection("teams").listDocuments();
    for (const team of teams) {
      const snap = await team.collection("taken").where("status", "==", "open").get();
      // verlopen, nog niet gemeld voor deze opvolgdatum, en niet ouder dan een week
      const verlopen = snap.docs.filter(d => {
        const t = d.data();
        return typeof t.opvolgOp === "number" && t.opvolgOp <= nu && t.opvolgOp > nu - WEEK && t.gemeldVoor !== t.opvolgOp;
      });
      if (!verlopen.length) continue;

      const tokens = await team.collection("tokens").get();
      const perNaam = {};
      tokens.docs.forEach(d => { const n = d.data().naam; (perNaam[n] = perNaam[n] || []).push(d); });

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
    if (taken) console.log(`${taken} verlopen taak/taken, ${verstuurd} melding(en) verstuurd, ${opgeruimd} apparaat/apparaten opgeruimd.`);
  }
);
