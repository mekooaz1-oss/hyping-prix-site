"use strict";
// Prix Hyping : lit l'API (prix chaque heure, ventes à chaque scan du menu) et affiche
//   #/            l'accueil : fraîcheur, infos du serveur, cartes classement, tableau filtrable
//   #/favoris     le même tableau, favoris seulement
//   #/objet/<id>  la page d'un objet : chiffres, courbe du prix, ventes par jour, calculateur
// Les filtres du tableau vont dans l'adresse (?q=&metier=&cat=&ventes=&tri=&sens=). Favoris et bonus
// de métier restent dans le navigateur (localStorage).

const PAGE = 100;
const PILE = 64, COFFRE = 3456;
const PEU = 100;                         // moins de PEU ventes en 7 j : « peu échangé »
const $ = (id) => document.getElementById(id);
const etat = {
  items: [], parId: new Map(), ts: [], noms: {}, meta: null, ventes: null, icones: null,
  montres: PAGE, tri: "vj", sens: -1, triDefaut: "vj", libelleVar: "24 h", boost: null, mois: {}, periode: "7 j",
};

const METIERS = ["Agriculteur", "Mineur", "Bûcheron", "Chasseur", "Pêcheur"];
const CLASSE_METIER = { Agriculteur: "agri", Mineur: "mine", "Bûcheron": "buch", Chasseur: "chas", "Pêcheur": "pech" };

const fmtPrix = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEntier = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const fmtCourt = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const fmtPct = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" });
const fmtUnPct = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtHeure = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtJourH = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtJour = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

function echapper(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function sansAccents(t) { return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
function joli(id) {
  const c = id.split(":").pop().replace(/_/g, " ");
  return c.charAt(0).toUpperCase() + c.slice(1);
}
function variation(a, b) { return a == null || b == null || a === 0 ? null : (b - a) / a; }
const signe = (v) => (v > 0 ? "hausse" : v < 0 ? "baisse" : "neutre");
const prixTxt = (v) => fmtPrix.format(v) + " " + (etat.meta.monnaie || "$");
const baisseTxt = (v) => (v == null ? "—" : (v > 0 ? "−" : "") + fmtUnPct.format(v) + " %");

// ------------------------------------------------------------------ mémoire du navigateur
function lireLocal(cle, defaut) {
  try { const v = localStorage.getItem(cle); return v == null ? defaut : JSON.parse(v); } catch { return defaut; }
}
function ecrireLocal(cle, v) { try { localStorage.setItem(cle, JSON.stringify(v)); } catch { /* navigation privée */ } }
const favoris = new Set(lireLocal("favoris", []));
function basculerFavori(id) {
  if (favoris.has(id)) favoris.delete(id); else favoris.add(id);
  ecrireLocal("favoris", [...favoris]);
  $("nb-favoris").textContent = favoris.size ? `(${favoris.size})` : "";
}

// bonus de vente du joueur, comme en jeu : le serveur MULTIPLIE les deux (90 % de prestige et 100 % de
// métier = 1,9 × 2 = 3,8, affiché +280 %). Objet de deux métiers : le meilleur des deux ; sans métier :
// le prestige seul.
const mesBonus = Object.assign({ prestige: 0, metiers: {} }, lireLocal("mesBonus", {}));
let avecBonus = !!lireLocal("avecBonus", false);
function meilleurMetier(it) {
  let m = null;
  for (const x of it.metiers) if (m == null || (+mesBonus.metiers[x] || 0) > (+mesBonus.metiers[m] || 0)) m = x;
  return m;
}
function multiplicateur(it) {
  const m = meilleurMetier(it);
  return (1 + (+mesBonus.prestige || 0) / 100) * (1 + (m ? +mesBonus.metiers[m] || 0 : 0) / 100);
}
// option « Bruts et faciles seulement » (liste site\simples.json, faite par simples.py) : tableau et cartes
let seulSimples = !!lireLocal("seulSimples", false);
const visible = (it) => !seulSimples || it.simple;
const prixVu = (it) => (avecBonus ? it.prix * multiplicateur(it) : it.prix);
const pctBonus = (k) => "+" + fmtEntier.format(Math.round((k - 1) * 1000) / 10) + " %";
const aDesBonus = () => (+mesBonus.prestige || 0) > 0 || Object.values(mesBonus.metiers).some((v) => +v > 0);
// « prestige +90 % × Agriculteur +100 % = +280 % »
function detailBonus(it) {
  const m = meilleurMetier(it), p = +mesBonus.prestige || 0, b = m ? +mesBonus.metiers[m] || 0 : 0;
  const morceaux = [];
  if (p) morceaux.push(`prestige +${fmtEntier.format(p)} %`);
  if (b) morceaux.push(`${m} +${fmtEntier.format(b)} %`);
  if (!morceaux.length) return "aucun bonus renseigné";
  return morceaux.join(" × ") + (morceaux.length > 1 ? ` = ${pctBonus(multiplicateur(it))}` : "");
}

// ------------------------------------------------------------------ données
// ?api=... pour essayer une autre API (ex. http://localhost:8787/donnees/)
const API = new URLSearchParams(location.search).get("api") || "https://hyping-prix.mekooaz.workers.dev/donnees/";

async function charger(nom, facultatif) {
  const url = nom.endsWith(".json") ? nom : API + nom;
  try {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(nom + " : " + r.status);
    return await r.json();
  } catch (e) {
    if (facultatif) return null;
    throw e;
  }
}

// icône d'un objet : une case de la planche icones.webp (fabriquée par icones.py), affichée en `px`
function icone(id, px) {
  const ic = etat.icones;
  const k = ic && ic.index[id];
  if (k == null) return `<span class="icone vide" style="width:${px}px;height:${px}px"></span>`;
  const x = (k % ic.colonnes) * px, y = Math.floor(k / ic.colonnes) * px;
  return `<span class="icone" style="width:${px}px;height:${px}px;background-size:${ic.colonnes * px}px ${ic.lignes * px}px;background-position:-${x}px -${y}px"></span>`;
}

// le panneau du menu : « ✦ Ressource boostée cette semaine : Fer brut (+150%) »...
function lireInfos(ventes) {
  const lignes = (ventes && ventes.infos) || [];
  const trouver = (re) => {
    const l = lignes.find((x) => re.test(x));
    if (!l) return null;
    const [titre, valeur] = l.replace(/^[^\p{L}]+/u, "").split(/\s*:\s*/);
    return { titre, valeur: valeur || "" };
  };
  return { boost: trouver(/boost/i), top: trouver(/plus vendue/i), hausse: trouver(/hausse/i) };
}

function preparer(dernier, horaire, ventes) {
  const ts = horaire.ts, fin = ts.length - 1;
  let i24 = -1;                          // le relevé le plus proche de 24 h avant le dernier
  for (let i = fin; i >= 0; i--) if (ts[fin] - ts[i] >= 23 * 3600) { i24 = i; break; }
  etat.libelleVar = i24 >= 0 ? "24 h" : "depuis " + fmtHeure.format(new Date(ts[0] * 1000));
  etat.ts = ts;
  const vt = (ventes && ventes.items) || {};
  const cl = (ventes && ventes.classement) || {};
  const infos = lireInfos(ventes);
  const boost = infos.boost && infos.boost.valeur.match(/^(.*?)\s*\(([^)]*)\)/);
  etat.items = dernier.items.map(([id, type, prix]) => {
    const serie = horaire.prix[id] || [];
    let avant = null;
    for (let i = fin - 1; i >= 0; i--) if (serie[i] != null) { avant = serie[i]; break; }
    const premier = serie.find((v) => v != null);
    const vals = serie.filter((v) => v != null);
    const nom = etat.noms[id] || joli(id);
    const [vj, v7, tend, pileB, coffreB] = vt[id] || [];
    const [categorie, metiers] = cl[id] || [null, []];
    return {
      id, type, prix, nom, serie,
      categorie: type === "vanilla" ? categorie : "Serveur",
      metiers: metiers || [],
      cle: sansAccents(nom + " " + id),
      var1: variation(avant, prix),
      var24: variation(i24 >= 0 ? serie[i24] : premier, prix),
      min: vals.length ? Math.min(...vals) : prix,
      max: vals.length ? Math.max(...vals) : prix,
      moy: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : prix,
      vj: vj ?? null, v7: v7 ?? null,
      tend: tend == null ? null : tend / 100,
      pileB: pileB ?? null, coffreB: coffreB ?? null,
      argent: vj == null ? null : vj * prix,
      activite: v7 ? vj / (v7 / 7) : null,
      peu: v7 != null && v7 < PEU,
      simple: !etat.simples || etat.simples.has(id),
      boost: boost && boost[1] === nom ? boost[2].replace(/(\d)%/, "$1 %") : null,
    };
  });
  etat.parId = new Map(etat.items.map((it) => [it.id, it]));
}

// ------------------------------------------------------------------ filtres et tris
const TRIS = {
  prix: { nom: "Prix", v: (it) => prixVu(it) },
  nom: { nom: "Nom", v: (it) => it.nom, texte: true },
  var1: { nom: "Variation 1 h", v: (it) => it.var1 },
  var24: { nom: "Variation 24 h", v: (it) => it.var24 },
  tend: { nom: "Tendance 7 jours", v: (it) => it.tend },
  vj: { nom: "Vendus aujourd'hui", v: (it) => it.vj },
  v7: { nom: "Vendus sur 7 jours", v: (it) => it.v7 },
  argent: { nom: "Montant vendu aujourd'hui", v: (it) => it.argent },
  activite: { nom: "Ventes du jour / moyenne", v: (it) => it.activite },
  coffreB: { nom: "Baisse pour un double coffre", v: (it) => it.coffreB },
};

function trier(l, cle, sens) {
  const t = TRIS[cle] || TRIS.prix;
  return l.sort((a, b) => {
    const x = t.v(a), y = t.v(b);
    if (x == null && y == null) return b.prix - a.prix;
    if (x == null) return 1;               // sans valeur : toujours à la fin
    if (y == null) return -1;
    if (t.texte) return sens * String(x).localeCompare(String(y), "fr");
    return sens * (x - y) || b.prix - a.prix;
  });
}

function filtres() {
  const q = sansAccents($("recherche").value.trim());
  const metier = $("metier").dataset.valeur || "";
  const cat = $("categorie").value;
  const vente = $("vente").value;
  const fav = $("seul-favoris").checked;
  const l = etat.items.filter((it) =>
    (!q || q.split(/\s+/).every((m) => it.cle.includes(m)))
    && (!fav || favoris.has(it.id))
    && visible(it)
    && (!metier || (metier === "aucun" ? !it.metiers.length : it.metiers.includes(metier)))
    && (!cat || it.categorie === cat)
    && (!vente
      || (vente === "jour" && it.vj > 0)
      || (vente === "semaine" && it.v7 > 0)
      || (vente === "jamais" && it.v7 === 0)
      || (vente === "monte" && it.activite != null && it.activite >= 2)));
  return trier(l, etat.tri, etat.sens);
}

function lireUrl() {
  const p = new URLSearchParams(location.search);
  $("recherche").value = p.get("q") || "";
  choisirMetier(p.get("metier") || "", false);
  $("categorie").value = p.get("cat") || "";
  $("vente").value = p.get("ventes") || "";
  if (TRIS[p.get("tri")]) etat.tri = p.get("tri");
  etat.sens = p.get("sens") === "asc" ? 1 : -1;
  if (!p.has("sens") && TRIS[etat.tri].texte) etat.sens = 1;
}

function ecrireUrl() {
  const p = new URLSearchParams();
  const api = new URLSearchParams(location.search).get("api");
  if (api) p.set("api", api);
  if ($("recherche").value.trim()) p.set("q", $("recherche").value.trim());
  if ($("metier").dataset.valeur) p.set("metier", $("metier").dataset.valeur);
  if ($("categorie").value) p.set("cat", $("categorie").value);
  if ($("vente").value) p.set("ventes", $("vente").value);
  if (etat.tri !== etat.triDefaut) p.set("tri", etat.tri);
  if (etat.sens === 1 && !TRIS[etat.tri].texte) p.set("sens", "asc");
  if (etat.sens === -1 && TRIS[etat.tri].texte) p.set("sens", "desc");
  const s = p.toString();
  history.replaceState(null, "", (s ? "?" + s : location.pathname) + location.hash);
}

function choisirMetier(v, maj = true) {
  const zone = $("metier");
  zone.dataset.valeur = v;
  for (const b of zone.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === v));
  if (maj) changer();
}

function changer() {
  etat.montres = PAGE;
  ecrireUrl();
  afficherTableau();
}

// ------------------------------------------------------------------ petits morceaux
function badges(it) {
  const b = [];
  if (it.categorie) b.push(`<span class="badge">${it.categorie === "Serveur" ? "Objet du serveur" : echapper(it.categorie)}</span>`);
  for (const m of it.metiers) b.push(`<span class="badge metier ${CLASSE_METIER[m] || ""}">${echapper(m)}</span>`);
  if (it.boost) b.push(`<span class="badge boost" title="Ressource boostée cette semaine">Boosté ${echapper(it.boost)}</span>`);
  if (it.peu) b.push(`<span class="badge peu" title="Moins de ${PEU} ventes en 7 jours : prix indicatif">Peu échangé</span>`);
  return b.length ? `<div class="badges">${b.join("")}</div>` : "";
}

function sparkline(it, w = 96, h = 28) {
  const pts = it.serie.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '<span class="neutre">—</span>';
  const n = it.serie.length - 1 || 1;
  const vs = pts.map(([, v]) => v);
  const mn = Math.min(...vs), mx = Math.max(...vs), d = mx - mn || 1;
  const p = pts.map(([i, v]) => `${(i / n * (w - 4) + 2).toFixed(1)},${(mx === mn ? h / 2 : h - 3 - (v - mn) / d * (h - 6)).toFixed(1)}`).join(" ");
  return `<svg class="spark ${signe(it.var24)}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Prix ${etat.libelleVar} : ${it.var24 == null ? "stable" : fmtPct.format(it.var24)}"><polyline points="${p}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function cellVar(v, mobile = "") {
  if (v == null) return `<td class="num neutre ${mobile}">—</td>`;
  return `<td class="num ${signe(v)} ${mobile}">${fmtPct.format(v)}</td>`;
}

function etoile(id, nom) {
  const f = favoris.has(id);
  return `<button type="button" class="etoile" data-fav="${echapper(id)}" aria-pressed="${f}" aria-label="${f ? "Retirer" : "Ajouter"} ${echapper(nom)} ${f ? "des" : "aux"} favoris">★</button>`;
}

const lienObjet = (id) => "#/objet/" + encodeURIComponent(id);

function age(ts) {
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 60) return `il y a ${Math.max(1, m)} min`;
  const h = m / 60;
  return h < 48 ? `il y a ${Math.floor(h)} h` : `il y a ${Math.floor(h / 24)} jours`;
}

// ------------------------------------------------------------------ accueil
function afficherFraicheur() {
  const meta = etat.meta, v = etat.ventes;
  const h = (Date.now() / 1000 - meta.ts) / 3600;
  const [c, txt] = h < 2 ? ["ok", "Données à jour"] : h < 12 ? ["moyen", "Données de quelques heures"] : ["vieux", "Données anciennes"];
  const prochaine = new Date(); prochaine.setMinutes(0, 0, 0); prochaine.setHours(prochaine.getHours() + 1);
  const quand = (ts) => (Date.now() / 1000 - ts < 20 * 3600 ? fmtHeure : fmtJourH).format(new Date(ts * 1000));
  const morceaux = [
    `<div class="etat ${c}">${txt}</div>`,
    `<div><span>Objets suivis</span> <b>${fmtEntier.format(etat.items.length)}</b></div>`,
    `<div><span>Prix relevés</span> <b>${quand(meta.ts)}</b> <span>(${age(meta.ts)})</span></div>`,
    v ? `<div><span>Ventes scannées</span> <b>${quand(v.ts)}</b> <span>(${age(v.ts)})</span></div>` : "",
    `<div><span>Prochain relevé</span> <b>${fmtHeure.format(prochaine)}</b></div>`,
    meta.contributeurs_7j ? `<div><span>Contributeurs</span> <b>${meta.contributeurs_7j}</b></div>` : "",
  ];
  $("fraicheur").innerHTML = morceaux.join("");
  $("serveur").textContent = `Skyblock ${meta.serveur || ""} · marché du /sell`;
}

function afficherInfos() {
  const i = lireInfos(etat.ventes);
  const z = $("infos");
  const html = [[i.boost, "boost"], [i.top, ""], [i.hausse, ""]].filter(([x]) => x)
    .map(([x, c]) => `<div class="info ${c}">${echapper(x.titre)} : <b>${echapper(x.valeur)}</b></div>`).join("");
  z.innerHTML = html;
  z.hidden = !html;
}

// une carte = 5 objets d'un critère + « Voir tout » (le tableau trié pareil)
function cartes() {
  const avec = (f) => etat.items.filter((it) => visible(it) && f(it));
  const haut = (l, cle, sens) => trier(l, cle, sens).slice(0, 5);
  const pct = (v) => [fmtPct.format(v), signe(v)];
  const depuis = etat.libelleVar === "24 h" ? "Prix sur 24 h" : "Prix " + etat.libelleVar;
  const scan = etat.ventes ? `Tout le serveur, scan de ${fmtHeure.format(new Date(etat.ventes.ts * 1000))}` : "";
  const l = [
    { titre: "Plus fortes hausses", sous: depuis, tri: "var24", sens: -1,
      objets: haut(avec((it) => it.var24 > 0), "var24", -1), val: (it) => pct(it.var24) },
    { titre: "Plus fortes baisses", sous: depuis, tri: "var24", sens: 1,
      objets: haut(avec((it) => it.var24 < 0), "var24", 1), val: (it) => pct(it.var24) },
  ];
  if (etat.ventes) {
    l.push(
      { titre: "Plus vendus aujourd'hui", sous: scan, tri: "vj", sens: -1,
        objets: haut(avec((it) => it.vj > 0), "vj", -1), val: (it) => [fmtEntier.format(it.vj), ""] },
      { titre: "Plus gros montant vendu aujourd'hui", sous: "Prix × quantité vendue", tri: "argent", sens: -1,
        objets: haut(avec((it) => it.argent > 0), "argent", -1), val: (it) => [fmtCourt.format(it.argent) + " $", ""] },
      { titre: "En forte hausse sur 7 jours", sous: "Tendance affichée par le serveur", tri: "tend", sens: -1,
        objets: haut(avec((it) => it.tend > 0 && !it.peu), "tend", -1), val: (it) => pct(it.tend) },
      { titre: "Vendre en masse sans faire baisser le prix", sous: `Baisse pour un double coffre (${fmtEntier.format(COFFRE)}), objets très vendus`,
        tri: "coffreB", sens: 1, vente: "semaine",
        objets: avec((it) => it.coffreB != null && it.v7 >= 10000)
          .sort((a, b) => a.coffreB - b.coffreB || b.v7 - a.v7).slice(0, 5),
        val: (it) => [baisseTxt(it.coffreB), ""] },
    );
  }
  return l.filter((c) => c.objets.length);
}

function afficherCartes() {
  const l = cartes();
  const z = $("cartes");
  z.innerHTML = l.map((c, k) => `
    <div class="carte">
      <div class="carte-tete"><h2>${c.titre}</h2><button type="button" class="voir" data-carte="${k}">Voir tout →</button></div>
      <p class="sous">${echapper(c.sous)}</p>
      ${c.objets.map((it, i) => {
        const [v, cl] = c.val(it);
        return `<a class="rang" href="${lienObjet(it.id)}"><span class="n">${i + 1}</span>${icone(it.id, 24)}<span class="nom">${echapper(it.nom)}</span><span class="val ${cl}">${v}</span></a>`;
      }).join("")}
    </div>`).join("");
  z.hidden = !l.length;
  z.onclick = (e) => {
    const b = e.target.closest("button[data-carte]");
    if (!b) return;
    const c = l[+b.dataset.carte];
    $("recherche").value = ""; $("categorie").value = ""; $("vente").value = c.vente || "";
    $("seul-favoris").checked = false; choisirMetier("", false);
    etat.tri = c.tri; etat.sens = c.sens;
    changer();
    $("tableau").scrollIntoView({ behavior: "smooth", block: "start" });
  };
}

function entetes() {
  for (const th of document.querySelectorAll("th[data-tri]")) {
    const actif = th.dataset.tri === etat.tri;
    th.classList.toggle("actif", actif);
    th.setAttribute("aria-sort", actif ? (etat.sens === 1 ? "ascending" : "descending") : "none");
    th.querySelector(".fleche").textContent = actif ? (etat.sens === 1 ? "▲" : "▼") : "";
  }
  document.querySelector('th[data-tri="prix"]').firstChild.textContent = avecBonus ? "Ton prix " : "Prix ";
  $("th-var24").firstChild.textContent = (etat.libelleVar === "24 h" ? "24 h" : "Var.") + " ";
  $("th-var24").title = "Variation " + etat.libelleVar;
  $("tri").value = etat.tri;
  $("sens").textContent = etat.sens === 1 ? "↑" : "↓";
  $("sens").title = etat.sens === 1 ? "Ordre croissant (cliquer pour inverser)" : "Ordre décroissant (cliquer pour inverser)";
}

function afficherTableau() {
  const l = filtres();
  entetes();
  const vendus = l.reduce((s, it) => s + (it.vj || 0), 0);
  const argent = l.reduce((s, it) => s + (it.argent || 0), 0);
  $("compte").innerHTML = `<b>${fmtEntier.format(l.length)}</b> objet${l.length > 1 ? "s" : ""}`
    + (etat.ventes ? ` · ${fmtCourt.format(vendus)} vendus aujourd'hui · ${fmtCourt.format(argent)} $` : "");
  if (!l.length) {
    $("lignes").innerHTML = `<tr><td colspan="10" class="vide">${$("seul-favoris").checked && !favoris.size
      ? "Pas encore de favori : clique sur l'étoile d'un objet." : "Aucun objet ne correspond."}</td></tr>`;
    $("plus").hidden = true;
    return;
  }
  const tiret = '<span class="neutre">—</span>';
  $("lignes").innerHTML = l.slice(0, etat.montres).map((it) => `
    <tr data-id="${echapper(it.id)}">
      <td>${etoile(it.id, it.nom)}</td>
      <td><div class="objet">${icone(it.id, 32)}<div class="txt"><a class="nom" href="${lienObjet(it.id)}">${echapper(it.nom)}</a>${badges(it)}</div></div></td>
      <td class="num"><b>${fmtPrix.format(prixVu(it))}</b>${avecBonus && multiplicateur(it) > 1 ? `<span class="mult" title="${echapper(detailBonus(it))} · prix du serveur ${fmtPrix.format(it.prix)}">${pctBonus(multiplicateur(it))}</span>` : ""}</td>
      ${cellVar(it.var1, "cache-mobile")}
      ${cellVar(it.var24)}
      ${cellVar(it.tend, "cache-mobile")}
      <td class="num">${it.vj == null ? tiret : fmtCourt.format(it.vj)}</td>
      <td class="num cache-mobile neutre">${it.v7 == null ? tiret : fmtCourt.format(it.v7)}</td>
      <td class="num cache-mobile ${it.coffreB >= 2 ? "baisse" : "neutre"}">${it.coffreB == null ? tiret : baisseTxt(it.coffreB)}</td>
      <td class="cache-mobile">${sparkline(it)}</td>
    </tr>`).join("");
  $("plus").hidden = l.length <= etat.montres;
}

function remplirFiltres() {
  const n = (f) => etat.items.filter(f).length;
  const metiers = [["", "Tous", etat.items.length], ...METIERS.map((m) => [m, m, n((it) => it.metiers.includes(m))]), ["aucun", "Sans métier", n((it) => !it.metiers.length)]];
  $("metier").innerHTML = metiers.map(([v, nom, k]) =>
    `<button type="button" data-v="${v}" class="puce ${CLASSE_METIER[v] || ""}" aria-pressed="false">${nom} <span>${k}</span></button>`).join("");
  const cats = [...new Set(etat.items.map((it) => it.categorie).filter(Boolean))]
    .sort((a, b) => (a === "Serveur" ? 1 : b === "Serveur" ? -1 : a.localeCompare(b, "fr")));
  $("categorie").innerHTML = '<option value="">Toutes les catégories</option>' +
    cats.map((c) => `<option value="${echapper(c)}">${c === "Serveur" ? "Objets du serveur" : echapper(c)} (${n((it) => it.categorie === c)})</option>`).join("");
  $("tri").innerHTML = Object.entries(TRIS).map(([k, t]) => `<option value="${k}">${t.nom}</option>`).join("");
  if (cats.length < 2) $("categorie").hidden = true;
  if (!etat.ventes) { $("vente").hidden = true; $("metier").hidden = true; }
}

// ------------------------------------------------------------------ recherche avec suggestions
// classées par ventes sur 7 jours (puis par prix) : en tapant « bl », le blé passe avant les blocs rares
const sugg = { liste: [], choisi: -1 };

function proposer() {
  const q = sansAccents($("recherche").value.trim());
  const z = $("suggestions");
  if (!q) { fermerSuggestions(); return; }
  const mots = q.split(/\s+/);
  sugg.liste = etat.items.filter((it) => mots.every((m) => it.cle.includes(m)))
    .sort((a, b) => (b.v7 || 0) - (a.v7 || 0) || (sansAccents(a.nom).startsWith(q) ? -1 : 0) - (sansAccents(b.nom).startsWith(q) ? -1 : 0) || b.prix - a.prix)
    .slice(0, 8);
  sugg.choisi = -1;
  if (!sugg.liste.length) {
    z.innerHTML = '<div class="titre">Aucun objet</div>';
  } else {
    z.innerHTML = `<div class="titre">${etat.ventes ? "Classés par ventes sur 7 jours" : "Objets"}</div>` + sugg.liste.map((it, i) => `
      <a class="suggestion" role="option" id="sugg-${i}" aria-selected="false" href="${lienObjet(it.id)}">
        ${icone(it.id, 28)}
        <span class="txt"><b>${echapper(it.nom)}</b><small>${it.v7 != null ? fmtEntier.format(it.v7) + " vendus en 7 j" : echapper(it.id)}${it.metiers.length ? " · " + echapper(it.metiers.join(", ")) : ""}</small></span>
        <b>${prixTxt(prixVu(it))}</b>
      </a>`).join("");
  }
  z.hidden = false;
  $("recherche").setAttribute("aria-expanded", "true");
}

function fermerSuggestions() {
  $("suggestions").hidden = true;
  $("recherche").setAttribute("aria-expanded", "false");
  $("recherche").removeAttribute("aria-activedescendant");
  sugg.choisi = -1;
}

function surligner(i) {
  sugg.choisi = i;
  for (const [k, el] of [...$("suggestions").querySelectorAll(".suggestion")].entries()) el.setAttribute("aria-selected", String(k === i));
  if (i >= 0) $("recherche").setAttribute("aria-activedescendant", "sugg-" + i);
}

function brancherRecherche() {
  const champ = $("recherche");
  champ.addEventListener("input", () => {
    proposer();
    if (!$("vue-accueil").hidden) changer();
  });
  champ.addEventListener("focus", () => { if (champ.value.trim()) proposer(); });
  champ.addEventListener("keydown", (e) => {
    const n = sugg.liste.length;
    if (e.key === "ArrowDown" && n) { e.preventDefault(); surligner((sugg.choisi + 1) % n); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); surligner((sugg.choisi - 1 + n) % n); }
    else if (e.key === "Enter" && n && !$("suggestions").hidden) {
      e.preventDefault();
      location.hash = lienObjet(sugg.liste[Math.max(0, sugg.choisi)].id);
      fermerSuggestions();
      champ.blur();
    } else if (e.key === "Escape") fermerSuggestions();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".recherche")) fermerSuggestions();
    else if (e.target.closest(".suggestion")) fermerSuggestions();
  });
}

// ------------------------------------------------------------------ graphiques (page objet)
const bulle = $("bulle");
function montrerBulle(texte, x, y) {
  bulle.innerHTML = texte;
  bulle.hidden = false;
  const l = bulle.offsetWidth;
  bulle.style.left = Math.min(window.innerWidth - l - 8, Math.max(8, x - l / 2)) + "px";
  bulle.style.top = (y - bulle.offsetHeight - 12) + "px";
}
const cacherBulle = () => { bulle.hidden = true; };

// points = [{t, v, bas?, haut?, texte}] ; une courbe, un viseur et une bulle au survol
function courbe(zone, points, fmtT) {
  const W = Math.max(300, zone.clientWidth), H = 260, G = 64, D = 14, Hh = 16, B = 28;
  if (points.length < 2) {
    zone.innerHTML = '<p class="vide">Pas encore assez de relevés pour cette période : elle se remplit au fil des heures et des jours.</p>';
    return;
  }
  const t0 = points[0].t, t1 = points[points.length - 1].t, dt = t1 - t0 || 1;
  let mn = Math.min(...points.map((p) => p.bas ?? p.v)), mx = Math.max(...points.map((p) => p.haut ?? p.v));
  if (mn === mx) { mn -= Math.max(1, mn * .05); mx += Math.max(1, mx * .05); }
  const marge = (mx - mn) * .08; mn = Math.max(0, mn - marge); mx += marge;
  const X = (t) => G + (t - t0) / dt * (W - G - D);
  const Y = (v) => Hh + (mx - v) / (mx - mn) * (H - Hh - B);
  const ligne = points.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
  const bande = points.some((p) => p.bas != null)
    ? `<polygon class="bande" points="${points.map((p) => `${X(p.t).toFixed(1)},${Y(p.haut).toFixed(1)}`).join(" ")} ${[...points].reverse().map((p) => `${X(p.t).toFixed(1)},${Y(p.bas).toFixed(1)}`).join(" ")}"/>` : "";
  const zoneSous = `<polygon class="zone" points="${X(t0)},${H - B} ${ligne} ${X(t1)},${H - B}"/>`;
  const gradu = [0, 1, 2, 3].map((k) => mn + (mx - mn) * k / 3).map((v) =>
    `<line class="axe" x1="${G}" x2="${W - D}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text x="${G - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${fmtPrix.format(v)}</text>`).join("");
  const nb = Math.min(points.length, Math.max(2, Math.floor((W - G) / 110)));
  const temps = Array.from({ length: nb }, (_, k) => t0 + dt * k / (nb - 1)).map((t, k) =>
    `<text x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="${k === 0 ? "start" : k === nb - 1 ? "end" : "middle"}">${fmtT(t)}</text>`).join("");
  const der = points[points.length - 1];
  zone.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Prix de ${fmtPrix.format(points[0].v)} à ${fmtPrix.format(der.v)}">
    ${gradu}${bande}${zoneSous}<polyline class="ligne" points="${ligne}"/>
    <circle class="point" cx="${X(der.t).toFixed(1)}" cy="${Y(der.v).toFixed(1)}" r="5"/>
    <line class="viseur" y1="${Hh}" y2="${H - B}" x1="0" x2="0" visibility="hidden"/><circle class="point marque" r="5" cx="0" cy="0" visibility="hidden"/>
    ${temps}<rect class="cible" x="${G}" y="0" width="${W - G - D}" height="${H - B}"/></svg>`;
  const svg = zone.querySelector("svg"), vis = svg.querySelector(".viseur"), marque = svg.querySelector(".marque");
  const cible = svg.querySelector(".cible");
  const bouger = (e) => {
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * W / r.width;
    let p = points[0];
    for (const q of points) if (Math.abs(X(q.t) - x) < Math.abs(X(p.t) - x)) p = q;
    vis.setAttribute("x1", X(p.t)); vis.setAttribute("x2", X(p.t));
    vis.setAttribute("visibility", "visible"); marque.setAttribute("visibility", "visible");
    marque.setAttribute("cx", X(p.t)); marque.setAttribute("cy", Y(p.v));
    montrerBulle(p.texte, r.left + X(p.t) * r.width / W, r.top + Y(p.v) * r.height / H);
  };
  cible.addEventListener("pointermove", bouger);
  cible.addEventListener("pointerdown", bouger);
  cible.addEventListener("pointerleave", () => { cacherBulle(); vis.setAttribute("visibility", "hidden"); marque.setAttribute("visibility", "hidden"); });
}

async function pointsPeriode(it, periode) {
  if (periode === "24 h" || periode === "7 j") {
    const debut = periode === "24 h" ? etat.ts[etat.ts.length - 1] - 24 * 3600 : 0;
    return it.serie.map((v, i) => ({ t: etat.ts[i], v })).filter((p) => p.v != null && p.t >= debut)
      .map((p) => ({ ...p, texte: `${fmtJourH.format(new Date(p.t * 1000))} : <b>${prixTxt(p.v)}</b>` }));
  }
  // 30 j / Tout : un point par jour (moyenne du jour, bande min – max), fichiers jours/AAAA-MM
  let mois = etat.meta.mois || [];
  if (periode === "30 j") mois = mois.slice(-2);
  await Promise.all(mois.filter((m) => !(m in etat.mois)).map(async (m) => { etat.mois[m] = await charger("jours/" + m, true); }));
  const pts = [];
  for (const m of mois) {
    const f = etat.mois[m];
    if (!f || !f.prix[it.id]) continue;
    f.jours.forEach((j, k) => {
      const d = f.prix[it.id][k];
      if (!d) return;
      const [bas, haut, moy] = d;
      const t = Date.parse(j + "T12:00:00") / 1000;
      pts.push({ t, v: moy, bas, haut, texte: `${fmtJour.format(new Date(t * 1000))} : <b>${prixTxt(moy)}</b> en moyenne<br>de ${fmtPrix.format(bas)} à ${fmtPrix.format(haut)}` });
    });
  }
  const limite = Date.now() / 1000 - 30 * 86400;
  return periode === "30 j" ? pts.filter((p) => p.t >= limite) : pts;
}

// ventes par jour (dernier scan de chaque jour) : barres ; un jour passé scanné avant 20 h est en
// pointillé (journée incomplète), l'heure du scan est dans la bulle
function barresVentes(zone, it) {
  const v = etat.ventes;
  const serie = v && v.vendus && v.vendus[it.id];
  if (!serie || !serie.some((x) => x != null)) { zone.innerHTML = '<p class="vide">Pas encore de scan des ventes pour cet objet.</p>'; return; }
  const W = Math.max(300, zone.clientWidth), H = 170, G = 64, D = 14, Hh = 12, B = 26;
  const mx = Math.max(...serie.map((x) => x || 0)) || 1;
  const n = serie.length, pas = (W - G - D) / Math.max(n, 7), larg = Math.min(48, Math.max(4, pas * .7));
  const Y = (x) => Hh + (1 - x / mx) * (H - Hh - B);
  const heures = v.heures || [];
  const barres = serie.map((x, i) => {
    if (x == null) return "";
    const h = heures[i] ? new Date(heures[i] * 1000) : null;
    const incomplet = h && i < n - 1 && h.getHours() < 20;
    const texte = `${fmtJour.format(new Date(v.jours[i]))} : <b>${fmtEntier.format(x)}</b> vendus${h ? `<br>scan de ${fmtHeure.format(h)}${incomplet ? " (journée incomplète)" : ""}` : ""}`;
    const xx = G + i * pas + (pas - larg) / 2;
    return `<rect class="barre${incomplet ? " incomplet" : ""}" data-texte="${echapper(texte)}" x="${xx.toFixed(1)}" y="${Y(x).toFixed(1)}" width="${larg.toFixed(1)}" height="${Math.max(1, H - B - Y(x)).toFixed(1)}" rx="4"/>
      <text x="${(xx + larg / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtJour.format(new Date(v.jours[i]))}</text>`;
  }).join("");
  const gradu = [0, mx / 2, mx].map((x) => `<line class="axe" x1="${G}" x2="${W - D}" y1="${Y(x).toFixed(1)}" y2="${Y(x).toFixed(1)}"/><text x="${G - 8}" y="${(Y(x) + 4).toFixed(1)}" text-anchor="end">${fmtCourt.format(x)}</text>`).join("");
  zone.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Vendus par jour">${gradu}${barres}</svg>`;
  for (const r of zone.querySelectorAll("rect[data-texte]")) {
    const montrer = () => { const b = r.getBoundingClientRect(); montrerBulle(r.dataset.texte, b.left + b.width / 2, b.top); };
    r.addEventListener("pointerenter", montrer);
    r.addEventListener("pointerdown", montrer);
    r.addEventListener("pointerleave", cacherBulle);
  }
}

// ------------------------------------------------------------------ calculateur
// baisse annoncée par le serveur : pileB % pour 64, coffreB % pour 3456 ; entre les deux on interpole,
// au-delà on prolonge. Le gain suit le prix moyen pendant la vente (moitié de la baisse finale).
function chuteEstimee(it, q) {
  const p = it.pileB || 0, c = it.coffreB ?? p;
  if (q <= PILE) return p * q / PILE;
  if (q <= COFFRE) return p + (q - PILE) / (COFFRE - PILE) * (c - p);
  return c * q / COFFRE;
}

// bâton de vente : multiplie la vente (×1,5, ×2, ×3 ou ×4), en plus des bonus ; retenu dans le navigateur
const BATONS = [1, 1.5, 2, 3, 4];
const baton = () => (BATONS.includes(+lireLocal("baton", 1)) ? +lireLocal("baton", 1) : 1);
// happy hour : ×1,1 sur la vente pendant l'heure du happy hour, en plus du reste ; retenu dans le navigateur
const HAPPY_HOUR = 1.1;
const happyHour = () => !!lireLocal("happyHour", false);

function calculateur(it) {
  return `
    <section class="panneau calc" aria-label="Calculateur de vente">
      <h2>Combien je gagne ?</h2>
      <div>
        <label for="calc-q">Quantité à vendre</label>
        <input id="calc-q" type="number" min="1" step="1" inputmode="numeric" value="${COFFRE}">
        <div class="raccourcis">
          <button type="button" data-q="${PILE}">1 pile</button>
          <button type="button" data-q="${COFFRE / 2}">1 coffre</button>
          <button type="button" data-q="${COFFRE}">1 double coffre</button>
          <button type="button" data-q="${COFFRE * 10}">10 doubles coffres</button>
        </div>
      </div>
      <div>
        <b>Mes bonus</b> <button type="button" class="lien-bouton" data-ouvrir-bonus>Modifier</button>
        <p class="note" style="margin-top:4px">${aDesBonus() ? echapper(detailBonus(it)) : "Aucun bonus renseigné : clique sur « Modifier » pour ajouter ton prestige et tes métiers."}</p>
      </div>
      <div>
        <b id="titre-baton">Bâton de vente</b>
        <div class="puces batons" role="group" aria-labelledby="titre-baton" style="margin-top:6px">
          ${BATONS.map((b) => `<button type="button" class="puce" data-baton="${b}" aria-pressed="${b === baton()}">${b === 1 ? "Sans" : "×" + String(b).replace(".", ",")}</button>`).join("")}
        </div>
      </div>
      <div>
        <b id="titre-happy">Happy hour</b>
        <div class="puces batons" role="group" aria-labelledby="titre-happy" style="margin-top:6px">
          <button type="button" class="puce" data-happy="0" aria-pressed="${!happyHour()}">Sans</button>
          <button type="button" class="puce" data-happy="1" aria-pressed="${happyHour()}">Pendant le happy hour (×1,1)</button>
        </div>
      </div>
      <div class="resultat" id="calc-resultat"></div>
      <p class="note">${it.coffreB == null
        ? "Pas encore de baisse connue pour cet objet : le calcul suppose un prix fixe."
        : `Estimation à partir des baisses annoncées par le serveur : ${baisseTxt(it.pileB || 0)} pour une pile (${PILE}), ${baisseTxt(it.coffreB)} pour un double coffre (${fmtEntier.format(COFFRE)}).`}</p>
    </section>`;
}

function brancherCalculateur(it) {
  const q = $("calc-q");
  const calc = () => {
    const n = Math.max(0, Math.floor(+q.value || 0)), k = multiplicateur(it), bt = baton();
    const chute = chuteEstimee(it, n);
    const hh = happyHour() ? HAPPY_HOUR : 1;
    const brut = n * it.prix, apres = brut * (1 - chute / 200), avecBonus_ = apres * k, avecBaton = avecBonus_ * bt;
    const total = avecBaton * hh;
    $("calc-resultat").innerHTML = `
      <div><span>Au prix du serveur</span><span>${prixTxt(brut)}</span></div>
      <div><span>Baisse du prix estimée</span><span class="baisse">−${prixTxt(brut - apres)} (${fmtUnPct.format(chute)} %)</span></div>
      <div><span>Mes bonus${k > 1 ? " (" + pctBonus(k) + ")" : ""}</span><span class="hausse">+${prixTxt(avecBonus_ - apres)}</span></div>
      ${bt > 1 ? `<div><span>Bâton de vente (×${String(bt).replace(".", ",")})</span><span class="hausse">+${prixTxt(avecBaton - avecBonus_)}</span></div>` : ""}
      ${hh > 1 ? `<div><span>Happy hour (×1,1)</span><span class="hausse">+${prixTxt(total - avecBaton)}</span></div>` : ""}
      <div class="total"><span>Tu touches environ</span><b>${prixTxt(total)}</b></div>`;
  };
  q.oninput = calc;
  for (const r of document.querySelectorAll(".raccourcis button")) r.onclick = () => { q.value = r.dataset.q; calc(); };
  for (const b of document.querySelectorAll("[data-baton]")) b.onclick = () => {
    ecrireLocal("baton", +b.dataset.baton);
    for (const x of document.querySelectorAll("[data-baton]")) x.setAttribute("aria-pressed", String(x === b));
    calc();
  };
  for (const b of document.querySelectorAll("[data-happy]")) b.onclick = () => {
    ecrireLocal("happyHour", b.dataset.happy === "1");
    for (const x of document.querySelectorAll("[data-happy]")) x.setAttribute("aria-pressed", String(x === b));
    calc();
  };
  calc();
}
// ------------------------------------------------------------------ page objet
function tuile(titre, valeur, sous = "", classe = "") {
  return `<div class="tuile"><small>${titre}</small><b class="${classe}">${valeur}</b>${sous ? `<span>${sous}</span>` : ""}</div>`;
}

function pageObjet(id) {
  const it = etat.parId.get(id);
  const z = $("vue-objet");
  if (!it) {
    z.innerHTML = `<div class="fil"><a href="#/">← Marché</a></div><p class="vide">Objet inconnu : ${echapper(id)}.</p>`;
    return;
  }
  document.title = `${it.nom} : ${fmtPrix.format(it.prix)} $ · Prix Hyping`;
  const f = favoris.has(it.id);
  const scan = etat.ventes ? `scan de ${fmtHeure.format(new Date(etat.ventes.ts * 1000))}` : "";
  const ventes = it.vj == null ? "" :
    tuile("Vendus aujourd'hui", fmtEntier.format(it.vj), "tout le serveur, " + scan)
    + tuile("Vendus sur 7 jours", fmtEntier.format(it.v7), it.v7 ? `environ ${fmtEntier.format(it.v7 / 7)} par jour` : "")
    + tuile("Aujourd'hui / moyenne", it.activite == null ? "—" : "×" + fmtPrix.format(it.activite), "ventes du jour comparées à la moyenne", it.activite >= 2 ? "hausse" : "");
  const periodes = ["24 h", "7 j", "30 j", "Tout"];
  const k = multiplicateur(it), kv = avecBonus ? k : 1;   // kv : appliqué à ce qui est affiché
  const heure = fmtHeure.format(new Date(etat.meta.ts * 1000));
  z.innerHTML = `
    <div class="fil">
      <a href="#/">← Marché</a>
      <span class="chemin">${it.categorie ? (it.categorie === "Serveur" ? "Objets du serveur" : echapper(it.categorie)) + " / " : ""}${echapper(it.nom)}</span>
      <div class="actions">
        <button type="button" class="bouton fav" id="obj-fav" aria-pressed="${f}">${f ? "★ Dans mes favoris" : "☆ Ajouter aux favoris"}</button>
        <button type="button" class="bouton" id="obj-lien">Copier le lien</button>
      </div>
    </div>
    <section class="tete-objet">
      <div class="ident">${icone(it.id, 56)}<div><h1>${echapper(it.nom)}</h1><span class="id">${echapper(it.id)}</span>${badges(it)}</div></div>
      <div class="chiffres">
        ${avecBonus && k > 1
          ? `<div class="gros principal"><small>Ton prix (${pctBonus(k)})</small><b class="hausse">${prixTxt(it.prix * k)}</b><span class="serveur-prix">prix du serveur ${prixTxt(it.prix)} à ${heure}</span></div>`
          : `<div class="gros principal"><small>Prix actuel (${heure})</small><b>${prixTxt(it.prix)}</b>${k > 1 ? `<span class="serveur-prix">avec tes bonus : ${prixTxt(it.prix * k)} (${pctBonus(k)})</span>` : ""}</div>`}
        <div class="gros"><small>${etat.libelleVar === "24 h" ? "Sur 24 h" : etat.libelleVar.replace(/^d/, "D")}</small><b class="${signe(it.var24)}">${it.var24 == null ? "—" : fmtPct.format(it.var24)}</b></div>
        <div class="gros"><small>Tendance 7 jours</small><b class="${signe(it.tend)}">${it.tend == null ? "—" : fmtPct.format(it.tend)}</b></div>
      </div>
    </section>
    <section class="tuiles">
      ${ventes}
      ${tuile(`Une pile (${PILE})`, "≈ " + prixTxt(it.prix * kv * PILE), it.pileB == null ? "au prix actuel" : "baisse du prix : " + baisseTxt(it.pileB))}
      ${tuile(`Un double coffre (${fmtEntier.format(COFFRE)})`, "≈ " + prixTxt(it.prix * kv * COFFRE), it.coffreB == null ? "au prix actuel" : "baisse du prix : " + (it.coffreB >= 2 ? `<b class="baisse" style="display:inline;font-size:inherit">${baisseTxt(it.coffreB)}</b>` : baisseTxt(it.coffreB)))}
      ${tuile(`Min – max ${etat.meta.jours_horaire} j`, fmtPrix.format(it.min * kv) + " – " + fmtPrix.format(it.max * kv), "moyenne " + prixTxt(it.moy * kv))}
    </section>
    <div class="colonnes">
      <div class="gauche">
        <section class="panneau" aria-label="Prix">
          <div class="periodes"><h2>${kv > 1 ? "Ton prix" : "Prix"} ${it.nom.length < 24 ? "de " + echapper(it.nom) : ""}</h2>
            ${periodes.map((p) => `<button type="button" class="puce" data-periode="${p}" aria-pressed="${p === etat.periode}">${p}</button>`).join("")}
          </div>
          <div class="graphe" id="g-prix"></div>
          <p class="note">Survole la courbe pour le prix exact. 30 j et Tout : un point par jour (moyenne), la bande va du prix le plus bas au plus haut du jour.</p>
        </section>
        <section class="panneau" aria-label="Ventes par jour">
          <h2>Vendus par jour (tout le serveur)</h2>
          <div class="graphe" id="g-ventes"></div>
          <p class="note">Une barre en pointillé : jour scanné avant 20 h, journée incomplète.</p>
        </section>
      </div>
      <div class="droite">${calculateur(it)}</div>
    </div>`;
  const dessiner = async () => {
    for (const b of z.querySelectorAll("[data-periode]")) b.setAttribute("aria-pressed", String(b.dataset.periode === etat.periode));
    let pts = await pointsPeriode(it, etat.periode);
    if (kv !== 1) pts = pts.map((p) => ({ ...p, v: p.v * kv, bas: p.bas == null ? null : p.bas * kv, haut: p.haut == null ? null : p.haut * kv,
      texte: p.texte.replace(/[\d\s ]+,\d\d/g, (x) => fmtPrix.format(parseFloat(x.replace(/[\s ]/g, "").replace(",", ".")) * kv)) }));
    const jour = etat.periode === "30 j" || etat.periode === "Tout";
    const fmtT = (t) => (jour ? fmtJour : etat.periode === "24 h" ? fmtHeure : fmtJourH).format(new Date(t * 1000));
    if ($("g-prix")) courbe($("g-prix"), pts, fmtT);
  };
  z.querySelector(".periodes").onclick = (e) => {
    const b = e.target.closest("[data-periode]");
    if (b) { etat.periode = b.dataset.periode; dessiner(); }
  };
  $("obj-fav").onclick = () => { basculerFavori(it.id); pageObjet(it.id); };
  $("obj-lien").onclick = async () => {
    const url = location.origin + location.pathname + lienObjet(it.id);
    try { await navigator.clipboard.writeText(url); $("obj-lien").textContent = "Lien copié ✔"; } catch { prompt("Lien de la page :", url); }
  };
  brancherCalculateur(it);
  for (const b of z.querySelectorAll("[data-ouvrir-bonus]")) b.onclick = ouvrirBonus;
  dessiner();
  barresVentes($("g-ventes"), it);
  z.redessiner = () => { dessiner(); barresVentes($("g-ventes"), it); };
}

// ------------------------------------------------------------------ mes bonus (fenêtre + interrupteur)
function resumeBonus() {
  const p = +mesBonus.prestige || 0;
  const meilleur = Math.max(0, ...METIERS.map((m) => +mesBonus.metiers[m] || 0));
  $("resume-bonus").textContent = aDesBonus() ? `jusqu'à ${pctBonus((1 + p / 100) * (1 + meilleur / 100))}` : "";
  $("avec-bonus").checked = avecBonus;
  $("avec-bonus").disabled = !aDesBonus();
  $("avec-bonus").closest("label").title = aDesBonus() ? "" : "Renseigne d'abord tes bonus (bouton « Mes bonus »)";
}

function exempleBonus() {
  const p = +mesBonus.prestige || 0;
  const l = METIERS.filter((m) => +mesBonus.metiers[m] > 0)
    .map((m) => `${m} : ${pctBonus((1 + p / 100) * (1 + mesBonus.metiers[m] / 100))}`);
  $("exemple-bonus").innerHTML = aDesBonus()
    ? `Ton bonus total, comme en jeu :<br>${[...l, `objets sans métier : ${pctBonus(1 + p / 100)}`].map(echapper).join("<br>")}`
    : "Renseigne ton prestige et tes métiers pour voir ton bonus total.";
}

function ouvrirBonus() {
  $("bonus-prestige").value = mesBonus.prestige || "";
  $("bonus-metiers").innerHTML = METIERS.map((m, i) => `
    <div><label for="bonus-m${i}">${m} (%)</label>
    <input id="bonus-m${i}" type="number" min="0" step="1" inputmode="numeric" data-bonus="${m}" value="${mesBonus.metiers[m] || ""}"></div>`).join("");
  exempleBonus();
  $("dialogue-bonus").showModal();
}

function rafraichir() {
  resumeBonus();
  if (!$("vue-objet").hidden) {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith("/objet/")) pageObjet(h.slice(7));
  } else afficherTableau();
  if (sugg.liste.length && !$("suggestions").hidden) proposer();
}

function brancherBonus() {
  $("btn-bonus").onclick = ouvrirBonus;
  $("dialogue-bonus").addEventListener("input", (e) => {
    const champ = e.target.closest("input[data-bonus]");
    if (!champ) return;
    const v = Math.max(0, +champ.value || 0);
    if (champ.dataset.bonus === "prestige") mesBonus.prestige = v; else mesBonus.metiers[champ.dataset.bonus] = v;
    ecrireLocal("mesBonus", mesBonus);
    if (aDesBonus() && !avecBonus && !lireLocal("bonusDejaActive", false)) {   // 1re fois : on l'active pour toi
      avecBonus = true; ecrireLocal("avecBonus", true); ecrireLocal("bonusDejaActive", true);
    }
    if (!aDesBonus()) { avecBonus = false; ecrireLocal("avecBonus", false); }
    exempleBonus();
    rafraichir();
  });
  $("avec-bonus").addEventListener("change", () => {
    avecBonus = $("avec-bonus").checked;
    ecrireLocal("avecBonus", avecBonus);
    rafraichir();
  });
  if (!aDesBonus()) avecBonus = false;
  resumeBonus();
}

// ------------------------------------------------------------------ navigation
function route() {
  cacherBulle();
  let h = decodeURIComponent(location.hash.slice(1));
  if (h && !h.startsWith("/")) { location.replace("#/objet/" + encodeURIComponent(h)); return; }   // anciens liens #minecraft:...
  const objet = h.startsWith("/objet/") ? h.slice(7) : null;
  $("vue-accueil").hidden = !!objet;
  $("vue-objet").hidden = !objet;
  $("nav-marche").toggleAttribute("aria-current", !objet && h !== "/favoris");
  $("nav-favoris").toggleAttribute("aria-current", h === "/favoris");
  if ($("nav-marche").hasAttribute("aria-current")) $("nav-marche").setAttribute("aria-current", "page");
  if ($("nav-favoris").hasAttribute("aria-current")) $("nav-favoris").setAttribute("aria-current", "page");
  if (objet) {
    pageObjet(objet);
    window.scrollTo(0, 0);
    return;
  }
  document.title = "Prix Hyping";
  $("seul-favoris").checked = h === "/favoris";
  $("titre-tableau").textContent = h === "/favoris" ? "Mes favoris" : "Tous les objets";
  afficherTableau();
  if (h === "/favoris") $("tableau").scrollIntoView({ block: "start" });
}

async function demarrer() {
  try {
    const [meta, dernier, horaire, ventes, noms, icones, simples] = await Promise.all([
      charger("meta"), charger("dernier"), charger("horaire"), charger("ventes", true), charger("noms.json", true),
      fetch("icones.json").then((r) => (r.ok ? r.json() : null)).catch(() => null), charger("simples.json", true)]);
    etat.simples = simples ? new Set(simples) : null;
    etat.meta = meta;
    etat.icones = icones;
    etat.noms = noms || {};
    etat.ventes = ventes;
    preparer(dernier, horaire, ventes);
  } catch (e) {
    $("fraicheur").textContent = "Données indisponibles";
    $("lignes").innerHTML = `<tr><td colspan="10" class="vide">Impossible de charger les prix (${echapper(e.message)}).</td></tr>`;
    return;
  }
  $("nb-favoris").textContent = favoris.size ? `(${favoris.size})` : "";
  if (!etat.ventes) etat.tri = etat.triDefaut = "prix";   // sans scan des ventes : par prix
  afficherFraicheur();
  afficherInfos();
  afficherCartes();
  remplirFiltres();
  lireUrl();
  brancherRecherche();
  brancherBonus();
  $("seul-simples").checked = seulSimples;
  $("seul-simples").addEventListener("change", () => {
    seulSimples = $("seul-simples").checked;
    ecrireLocal("seulSimples", seulSimples);
    afficherCartes();
    changer();
  });
  if (!etat.simples) $("seul-simples").closest(".option-simples").hidden = true;
  for (const id of ["categorie", "vente"]) $(id).addEventListener("change", changer);
  $("seul-favoris").addEventListener("change", changer);
  $("metier").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (b) choisirMetier(b.dataset.v === $("metier").dataset.valeur ? "" : b.dataset.v);
  });
  $("tri").addEventListener("change", () => { etat.tri = $("tri").value; etat.sens = TRIS[etat.tri].texte ? 1 : -1; changer(); });
  $("sens").onclick = () => { etat.sens = -etat.sens; changer(); };
  for (const th of document.querySelectorAll("th[data-tri]")) {
    th.addEventListener("click", () => {
      if (etat.tri === th.dataset.tri) etat.sens = -etat.sens;
      else { etat.tri = th.dataset.tri; etat.sens = TRIS[etat.tri].texte ? 1 : -1; }
      changer();
    });
  }
  $("raz").onclick = () => {
    $("recherche").value = ""; $("categorie").value = ""; $("vente").value = ""; $("seul-favoris").checked = false;
    etat.tri = etat.triDefaut; etat.sens = -1; choisirMetier("", false); changer();
  };
  $("plus").onclick = () => { etat.montres += PAGE; afficherTableau(); };
  $("lignes").addEventListener("click", (e) => {
    const fav = e.target.closest("button[data-fav]");
    if (fav) {
      basculerFavori(fav.dataset.fav);
      const on = favoris.has(fav.dataset.fav);
      fav.setAttribute("aria-pressed", String(on));
      if ($("seul-favoris").checked) afficherTableau();
      return;
    }
    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr[data-id]");
    if (tr) location.hash = lienObjet(tr.dataset.id);
  });
  let attente;
  window.addEventListener("resize", () => {
    clearTimeout(attente);
    attente = setTimeout(() => { if (!$("vue-objet").hidden && $("vue-objet").redessiner) $("vue-objet").redessiner(); }, 150);
  });
  window.addEventListener("hashchange", route);
  route();
}

// ------------------------------------------------------------------ mode clair / sombre
// Sans choix, le site suit l'appareil. Le bouton fixe « light » ou « dark » (texte brut dans
// localStorage, lu aussi par le petit script en tête de index.html pour éviter un éclair blanc).
function themeActuel() {
  const t = document.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function majBoutonTheme() {
  const sombre = themeActuel() === "dark";
  const b = $("btn-theme");
  const soleil = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const lune = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
  b.innerHTML = sombre ? soleil : lune;
  b.setAttribute("aria-label", sombre ? "Passer en mode clair" : "Passer en mode sombre");
  b.title = sombre ? "Mode clair" : "Mode sombre";
}
function installerTheme() {
  $("btn-theme").addEventListener("click", () => {
    const t = themeActuel() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("theme", t); } catch { /* navigation privée */ }
    majBoutonTheme();
    if (!$("vue-objet").hidden && $("vue-objet").redessiner) $("vue-objet").redessiner();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", majBoutonTheme);
  majBoutonTheme();
}

installerTheme();
demarrer();
