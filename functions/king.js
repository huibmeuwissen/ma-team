// Zet de KING-export (CSV's van king-export.ps1) om naar de klantgegevens voor het teamdashboard.
// BEWUST NIET mee: omzet, facturen, marges, inkoop- en kostprijzen.
// Alleen klanten, contactgegevens, vertegenwoordiger en contacthistorie.

function parseCsv(tekst) {
  if (tekst.charCodeAt(0) === 0xfeff) tekst = tekst.slice(1);
  const rijen = []; let rij = [], veld = "", inQ = false, i = 0, quoted = false;
  while (i < tekst.length) {
    const c = tekst[i];
    if (inQ) {
      if (c === '"') { if (tekst[i + 1] === '"') { veld += '"'; i += 2; continue; } inQ = false; i++; continue; }
      veld += c; i++; continue;
    }
    if (c === '"') { inQ = true; quoted = true; i++; continue; }
    if (c === ";") { rij.push(veld); veld = ""; quoted = false; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { rij.push(veld); rijen.push(rij); rij = []; veld = ""; quoted = false; i++; continue; }
    veld += c; i++;
  }
  if (veld !== "" || quoted || rij.length) { rij.push(veld); rijen.push(rij); }
  const kop = rijen.shift() || [];
  return rijen.filter(r => r.length > 1).map(r => { const o = {}; kop.forEach((k, j) => { o[k] = (r[j] || "").trim(); }); return o; });
}

const SOORT = { B: "Bezoek", T: "Telefoon", TB: "Telefoon", M: "E-mail", W: "Website" };
function hoofdletter(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ""; }
function naamWie(s) { const n = hoofdletter(s); return n === "Dirkjan" ? "Dirk-Jan" : n; }

// bestanden: { klanten, vertegenwoordigers, contacten } als tekst; klaar: object uit klaar.json
function bouwDataset(bestanden, klaar, opties = {}) {
  const vanaf = opties.contactenVanaf || "2024-01-01";
  const maxTekst = opties.maxTekst || 500;
  const vtg = {};
  parseCsv(bestanden.vertegenwoordigers).forEach(v => {
    let n = v.RelVoornaam || (v.RelVolledigeNaam || "").replace(/\s+/g, " ");
    if (n === "Dirkjan") n = "Dirk-Jan";
    vtg[v.VtgCode] = n;
  });
  const perGid = {};   // NawFilGid -> klant
  const alle = [];
  parseCsv(bestanden.klanten).forEach(r => {
    if (!/^\d+$/.test(r.NawFilNummer)) return;
    const soort = r.NawSoort === "3" ? "rel" : r.NawSoort === "0" ? "deb" : null;
    if (!soort) return;   // crediteuren en overige niet
    const k = { n: Number(r.NawFilNummer), soort, naam: r.AdrNaam1 || r.NawFilZoekcode };
    const zet = (veld, w) => { if (w) k[veld] = w; };
    zet("naam2", r.AdrNaam2); zet("adres", [r.AdrStraat, r.AdrHuisnummer].filter(Boolean).join(" ")); zet("pc", r.AdrPostcode); zet("plaats", r.AdrPlaats);
    zet("tel", r.AdrTelefoon); zet("tel2", r.AdrTelefoon2); zet("email", r.AdrEmail); zet("vt", vtg[r.NawVertegenwCode] || "");
    k._gid = r.NawFilGid;
    perGid[r.NawFilGid] = k; alle.push(k);
  });
  const contacten = []; const heeftContact = {};
  parseCsv(bestanden.contacten).forEach(c => {
    const k = perGid[c.GnotNawFilGid]; if (!k) return;
    let d = (c.GnotInvoerDatum || "").slice(0, 10); if (d.length < 10) return;
    if (d > "2100") d = "2" + d.slice(1);   // typefout in KING (9026 -> 2026)
    if (d < vanaf) return;
    const soort = SOORT[(c.CosCode || "").toUpperCase()] || c.CosOms || "";
    let tekst = (c.GnotNotitie || "").replace(/ \/ /g, "\n");
    if (tekst.length > maxTekst) tekst = tekst.slice(0, maxTekst) + "…";
    contacten.push([k.n, d, soort, naamWie(c.GnotGebruiker), tekst]);
    heeftContact[k.n] = 1;
    if (!k.laatste || d > k.laatste) k.laatste = d;
  });
  // Relaties allemaal; debiteuren alleen als ze een vertegenwoordiger (geen webwinkel) of contacthistorie hebben
  const klanten = alle.filter(k => k.soort === "rel" || heeftContact[k.n] || (k.vt && !/^(Rein|Belgie|Intratuin)/.test(k.vt)));
  klanten.forEach(k => { delete k._gid; });
  contacten.sort((a, b) => (a[1] < b[1] ? 1 : -1));
  // Laatste orders (zonder bedragen): [ordernummer, datum, debiteurnummer, klantnaam, vertegenwoordiger, referentie]
  const orders = bestanden.laatste_orders ? parseCsv(bestanden.laatste_orders).map(o => [
    o.OrkNummer, (o.OrkDatum || "").slice(0, 10), o.DebiteurNummer, o.AdrNaam1 || (alle.find(k => String(k.n) === o.DebiteurNummer) || {}).naam || "", vtg[o.OrkVtgCode] || o.OrkVtgCode || "",
    (o.OrkReferentie || "").replace(/,\s*\d+[.,]\d{2}\)/g, ")")   // webshop zet het orderbedrag in de referentie: eruit
  ]).sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : Number(b[0]) - Number(a[0]))).slice(0, 10) : [];
  return {
    meta: { bron: "king", gebouwd: new Date().toISOString().slice(0, 16).replace("T", " "), export: klaar && klaar.klaar || "", contactenVanaf: vanaf },
    klanten, contacten, orders, kansen: {}, maanden: []
  };
}

// Knipt een groot JSON-object in stukken die in Firestore-documenten passen (max ~1 MB per document)
function inStukken(obj, max = 900000) {
  const s = JSON.stringify(obj); const delen = [];
  for (let i = 0; i < s.length; i += max) delen.push(s.slice(i, i + max));
  return delen;
}

module.exports = { parseCsv, bouwDataset, inStukken };
