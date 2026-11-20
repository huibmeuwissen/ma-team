// Cloud Function van het MA Teamdashboard: stuurt elke 2 minuten pushmeldingen voor verlopen taken.
// Uitrollen: in de map "MA Teamdashboard website" -> firebase deploy --only functions
// Let op: logs nooit met teamcodes, namen of taakteksten vullen.
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const WEEK = 7 * 24 * 60 * 60 * 1000;

exports.meldingen = onSchedule(
  { schedule: "every 2 minutes", region: "europe-west1", timeZone: "Europe/Amsterdam", memory: "256MiB", timeoutSeconds: 60, retryCount: 0 },
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

// ---------------------------------------------------------------------------------------------
// KING-gegevens: elke 30 minuten kijken of er een nieuwe export in Google Drive staat (map "MA KING export",
// gedeeld met het serviceaccount van deze functie, alleen lezen). Zo ja: klanten, contactgegevens,
// vertegenwoordiger en contacthistorie naar elk team in Firestore (teams/<code>/king/...).
// Geen omzet, marges of prijzen.
const { GoogleAuth } = require("google-auth-library");
const { bouwDataset, inStukken } = require("./king");
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const MAP = "MA KING export";

exports.kingSync = onSchedule(
  { schedule: "every 30 minutes", region: "europe-west1", timeZone: "Europe/Amsterdam", memory: "512MiB", timeoutSeconds: 300, retryCount: 0 },
  async () => {
    const db = getFirestore();
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
    const client = await auth.getClient();
    const get = async (url, tekst) => (await client.request({ url, responseType: tekst ? "text" : "json" })).data;
    const q = encodeURIComponent(`name='${MAP}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const mappen = (await get(`${DRIVE}?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`)).files || [];
    if (!mappen.length) { console.log("Map niet gevonden of niet gedeeld met het serviceaccount."); return; }
    const q2 = encodeURIComponent(`'${mappen[0].id}' in parents and trashed=false`);
    const bestanden = (await get(`${DRIVE}?q=${q2}&fields=files(id,name,modifiedTime)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`)).files || [];
    const byNaam = {}; bestanden.forEach(f => { byNaam[f.name] = f; });
    if (!byNaam["klaar.json"] || !byNaam["klanten.csv"] || !byNaam["contacten.csv"] || !byNaam["vertegenwoordigers.csv"]) { console.log("Export onvolledig."); return; }
    const versie = byNaam["klaar.json"].modifiedTime;
    const bron = db.doc("kingbron/status");
    const vorige = (await bron.get()).data() || {};
    const teams = await db.collection("teams").listDocuments();
    if (vorige.versie === versie && vorige.teams === teams.length) return;   // niets nieuws
    const lees = naam => get(`${DRIVE}/${byNaam[naam].id}?alt=media&supportsAllDrives=true`, true);
    const klaar = JSON.parse(String(await lees("klaar.json")).replace(/^﻿/, ""));
    const data = bouwDataset({ klanten: await lees("klanten.csv"), vertegenwoordigers: await lees("vertegenwoordigers.csv"), contacten: await lees("contacten.csv") }, klaar);
    const delen = inStukken(data);
    for (const team of teams) {
      const king = team.collection("king");
      for (let i = 0; i < delen.length; i++) await king.doc("deel-" + i).set({ d: delen[i] });
      for (let i = delen.length; i < delen.length + 5; i++) await king.doc("deel-" + i).delete().catch(() => {});
      await king.doc("status").set({ versie, delen: delen.length, klanten: data.klanten.length, contacten: data.contacten.length, export: data.meta.export, bijgewerkt: Date.now() });
    }
    await bron.set({ versie, teams: teams.length, bijgewerkt: Date.now() });
    console.log(`KING-gegevens bijgewerkt: ${data.klanten.length} klanten, ${data.contacten.length} contacten, ${delen.length} delen, ${teams.length} team(s).`);
  }
);
