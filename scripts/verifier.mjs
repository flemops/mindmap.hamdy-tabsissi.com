// Verification navigateur de bout en bout, a lancer apres toute modification de
// public/ : demarre server.js sur une base jetable, joue les parcours essentiels
// dans un vrai Chrome (headless, WebGL logiciel) au doigt (319 et 390 px) et a la
// souris (1440 px), et echoue sur toute erreur console ou attente non tenue.
//
//   npm run verifier                       jeu de donnees fixe (3 niveaux), 3 formats
//   npm run verifier -- --prod             copie locale de l'arbre public de la prod
//   npm run verifier -- --exemple          donnees d'exemple de db.js (base neuve)
//   npm run verifier -- --url https://...  serveur deja lance (ex. la prod), rien n'est demarre
//   npm run verifier -- --formats 390      formats au choix : 319, 390, 1440
//   npm run verifier -- --comparer .verif/empreinte-avant.json
//
// Sorties dans .verif/ (ignore par git) : <format>-<etape>.png a relire, et
// empreinte.json = etat numerique de chaque noeud (role, visibilite, echelle,
// couleur, opacites) a chaque etape. --comparer echoue si cet etat a change :
// filet de securite pour remanier scene.js sans changer le rendu.
//
// Chrome : celui du systeme (CHROME_PATH sinon emplacements usuels). Aucun
// navigateur n'est telecharge (playwright-core seul).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { chromium } from 'playwright-core'
import { signatureModifs } from './hooks/etat-git.mjs'

const RACINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SORTIE = path.join(RACINE, '.verif')
const PROD = 'https://mindmap.hamdy-tabsissi.com'
const args = process.argv.slice(2)
const option = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null }
const drapeau = (nom) => args.includes(nom)

const FORMATS = {
  319: { viewport: { width: 319, height: 884 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  390: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  1440: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
}
const formats = (option('--formats') ?? '319,390,1440').split(',').filter((f) => FORMATS[f])
const PAUSE_VOL = 2600 // ms : vol (600 ms) + amorti camera (~2 s) avant de mesurer

const CHROME = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync)
if (!CHROME) {
  console.error('Chrome introuvable : definir CHROME_PATH.')
  process.exit(2)
}

// --- Serveur jetable --------------------------------------------------------

let serveur = null
let travail = null

// Jeu de donnees par defaut : fixe, a trois niveaux (calque sur la prod), pour que
// le parcours exerce tous les roles (ouverte, enfant, petit, voisin, ancetre) et
// que l'empreinte couvre tous les reglages de apparence.js#ROLES.
const ARBRE_FIXE = [
  ['Accueil', 20, 12, 'Chaque note est posée sur un globe et contient ses propres notes.', [
    ['Guide', -60, 25, 'Comment naviguer.', [['Naviguer', 30, 10, ''], ['Structure', -40, -20, '']]],
    ['Projets', 70, -10, 'Une sélection de projets.', [['Portfolio', 0, 30, ''], ['EventMap', 120, -15, '']]],
    ['À propos', 180, 5, ''],
  ]],
  ['Seconde racine', -120, -30, '', [['Note A', 10, 10, '']]],
  // Branche synchronisee avec le site, figee ici (SITE_SYNC=off) : sert a verifier
  // le lien « Voir sur le site ».
  ['Sur le site', -60, -40, 'Ce que hamdy-tabsissi.com publie, tenu à jour automatiquement.', [
    ['Projets pro', 0, 20, '', [
      ['Projet du site', 30, 0, 'Résumé publié sur le site.', [], { source: 'site:projet:demo', lien: 'https://hamdy-tabsissi.com/projet/demo' }],
    ], { source: 'site:groupe:pro', lien: 'https://hamdy-tabsissi.com/' }],
  ], { source: 'site:racine', lien: 'https://hamdy-tabsissi.com/' }],
]

function creerBase(fichier) {
  const db = new DatabaseSync(fichier)
  db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES notes(id) ON DELETE CASCADE, x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0, titre TEXT NOT NULL, contenu TEXT NOT NULL DEFAULT '',
    source TEXT, lien TEXT);`)
  return db
}

function creerFixe(fichier) {
  const db = creerBase(fichier)
  const inserer = db.prepare('INSERT INTO notes (parent_id, x, y, titre, contenu, source, lien) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const poser = (parent, [titre, x, y, contenu, filles = [], { source = null, lien = null } = {}]) => {
    const { lastInsertRowid } = inserer.run(parent, x, y, titre, contenu, source, lien)
    for (const f of filles) poser(Number(lastInsertRowid), f)
  }
  for (const racine of ARBRE_FIXE) poser(null, racine)
  db.close()
}

/** Copie l'arbre public de la prod (lecture seule, memes ids et positions). */
async function copierProd(fichier) {
  const db = creerBase(fichier)
  const inserer = db.prepare('INSERT INTO notes (id, parent_id, x, y, titre, contenu, source, lien) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const copier = async (id) => {
    const { children } = await (await fetch(`${PROD}/api/notes/${id ?? 'root'}`)).json()
    for (const n of children) {
      inserer.run(n.id, n.parent_id, n.x, n.y, n.titre, n.contenu, n.source ?? null, n.lien ?? null)
      await copier(n.id)
    }
  }
  await copier(null)
  db.close()
}

async function demarrerServeur() {
  travail = mkdtempSync(path.join(tmpdir(), 'mindmap-verif-'))
  const base = path.join(travail, 'verif.db')
  // --exemple : base neuve, server.js y pose ses donnees d'exemple (db.js#seed).
  if (drapeau('--prod')) await copierProd(base)
  else if (!drapeau('--exemple')) creerFixe(base)
  const port = Number(process.env.VERIF_PORT ?? 3998)
  serveur = spawn(process.execPath, ['server.js'], {
    cwd: RACINE,
    // SITE_SYNC=off : l'arbre teste reste celui de la base, la synchro a ses propres tests.
    env: { ...process.env, PORT: String(port), MINDMAP_DB_PATH: base, SITE_SYNC: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let journal = ''
  serveur.stdout.on('data', (d) => (journal += d))
  serveur.stderr.on('data', (d) => (journal += d))
  const url = `http://127.0.0.1:${port}`
  for (const limite = Date.now() + 20_000; Date.now() < limite; await new Promise((r) => setTimeout(r, 200))) {
    if (serveur.exitCode !== null) throw new Error(`server.js arrete (code ${serveur.exitCode}) :\n${journal}`)
    try {
      if ((await fetch(`${url}/health`)).ok) return url
    } catch {}
  }
  throw new Error(`/health muet apres 20 s :\n${journal}`)
}

async function arreterServeur() {
  // Windows garde la base verrouillee tant que le processus vit : attendre sa fin.
  if (serveur && serveur.exitCode === null) {
    const fin = new Promise((r) => serveur.once('exit', r))
    serveur.kill()
    await fin
  }
  if (travail) rmSync(travail, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

// --- Verifications ----------------------------------------------------------

const echecs = []
const empreinte = {}
function verifier(condition, libelle) {
  console.log(`${condition ? '  ✔' : '  ✘'} ${libelle}`)
  if (!condition) echecs.push(libelle)
}

/** Etat numerique de chaque noeud cree : ce qu'appliquerEtat a ecrit, sans le bruit de camera. */
const lireEmpreinte = (page) => page.evaluate(async () => {
  const s = await import('/static/scene.js')
  const r = (x) => Math.round(x * 1000) / 1000
  const ids = [null, ...[...document.querySelectorAll('.etiquette')].map((e) => Number(e.dataset.id))]
  const etat = {}
  for (const id of ids) {
    const n = s.noeud(id)
    if (!n) continue
    etat[id ?? 'racine'] = {
      role: n.role,
      visible: n.ancre ? n.ancre.visible : true,
      bille: n.bille ? [n.bille.visible, r(n.bille.scale.x), n.bille.material.color.getHexString()] : null,
      halo: n.halo ? r(n.halo.material.opacity) : null,
      trait: n.trait ? r(n.trait.material.opacity) : null,
      globe: n.grille ? [n.grille.visible, r(n.grille.material.opacity), r(n.grille.scale.x), r(n.verre.material.opacity)] : null,
      tier: n.etiquette ? [...n.etiquette.element.classList].find((c) => /--(ouverte|enfant|petit|cachee)$/.test(c)) : null,
    }
  }
  return etat
})

const filAriane = (page) => page.evaluate(() => [...document.querySelectorAll('#fil-ariane li')].map((l) => l.textContent.trim()))
const debordement = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)

/** Centre a l'ecran de l'etiquette ou de la bille d'une note (ids : robustes aux titres en double). */
const positionEtiquette = (page, id) => page.waitForFunction((id) => {
  const e = document.querySelector(`.etiquette[data-id="${id}"]`)
  const r = e?.getBoundingClientRect()
  return r && r.width && getComputedStyle(e).opacity > 0.05 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
}, id, { timeout: 10_000 }).then((h) => h.jsonValue())

const positionBille = (page, id) => page.evaluate(async (id) => {
  const s = await import('/static/scene.js')
  const v = s.noeud(id).bille.getWorldPosition(s.camera.position.clone()).project(s.camera)
  return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight }
}, id)

// Decor spatial (28.25) : bornes, filante, bouton, mouvement reduit, aucun objet qui s'accumule.
async function verifierDecor(page, tactile) {
  const lire = () => page.evaluate(async () => {
    const m = await import('/static/scene.js')
    return m.ambiance.etat()
  })
  await page.evaluate(async () => { window.__m = await import('/static/scene.js') })
  const e = await lire()
  const max = tactile ? 700 : 1600
  verifier(e.couches === 3 && e.etoiles > 0 && e.etoiles <= max, `decor : ${e.etoiles} etoiles sur ${e.couches} couches (borne ${max})`)
  verifier(e.vaisseaux <= (tactile ? 1 : 3) && e.satellites <= (tactile ? 1 : 2), `decor : ${e.vaisseaux} vaisseau(x), ${e.satellites} satellite(s) (profil ${tactile ? 'mobile' : 'bureau'})`)
  verifier(e.rayonMinObserve >= 1000, `decor : tout au-dela de la distance max de la camera (rayon min ${Math.round(e.rayonMinObserve)} >= 1000)`)
  verifier(e.mouvement === true, 'decor : mouvement actif par defaut')

  await page.evaluate(async () => (await import('/static/scene.js')).ambiance.forcerFilante())
  await page.waitForTimeout(250)
  verifier((await lire()).filanteActive === true, 'decor : etoile filante lancee')
  // Rendu logiciel : quelques images/s, dt borne a 0,1 s par image -> la filante dure plus longtemps en temps reel.
  await page.waitForFunction(() => !window.__m.ambiance.etat().filanteActive, null, { timeout: 30000 })
  const apres = await lire()
  verifier(apres.filanteActive === false && apres.objets === e.objets, `decor : etoile filante terminee, aucun objet laisse dans la scene (active=${apres.filanteActive}, objets ${e.objets}→${apres.objets})`)

  // Bouton du decor : coupe puis rallume le mouvement, etat expose aux lecteurs d'ecran.
  const bouton = page.locator('#bouton-decor')
  const boite = await bouton.boundingBox()
  verifier(boite && boite.width >= 32 && boite.height >= 32, `decor : bouton assez grand (${Math.round(boite?.width)}x${Math.round(boite?.height)} px)`)
  await (tactile ? bouton.tap() : bouton.click())
  verifier((await bouton.getAttribute('aria-pressed')) === 'false' && (await lire()).mouvement === false, 'decor : bouton coupe le mouvement')
  await (tactile ? bouton.tap() : bouton.click())
  verifier((await bouton.getAttribute('aria-pressed')) === 'true' && (await lire()).mouvement === true, 'decor : bouton rallume le mouvement')

  // prefers-reduced-motion en cours de session : le bouton ne peut plus le lever.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() => document.querySelector('#bouton-decor').getAttribute('aria-disabled') === 'true', null, { timeout: 10000 })
  const reduit = await lire()
  verifier(reduit.mouvement === false && reduit.reduitSysteme === true && (await bouton.getAttribute('aria-disabled')) === 'true', 'decor : mouvement reduit par le systeme respecte (a chaud)')
  await page.evaluate(async () => (await import('/static/scene.js')).ambiance.forcerFilante())
  await page.waitForFunction(() => !window.__m.ambiance.etat().filanteActive, null, { timeout: 15000 })
  verifier((await lire()).filanteActive === false, 'decor : aucune etoile filante en mouvement reduit')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForFunction(() => document.querySelector('#bouton-decor').getAttribute('aria-disabled') === 'false', null, { timeout: 10000 })
  verifier((await lire()).mouvement === true, 'decor : mouvement retabli quand la preference disparait')
}

async function parcours(navigateur, nom, url, arbre) {
  const f = FORMATS[nom]
  const tactile = Boolean(f.hasTouch)
  console.log(`\n${nom} px (${tactile ? 'doigt' : 'souris'})`)
  const ctx = await navigateur.newContext(f)
  const page = await ctx.newPage()
  const erreurs = []
  page.on('pageerror', (e) => erreurs.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && erreurs.push(m.text()))
  const viser = (p) => (tactile ? page.touchscreen.tap(p.x, p.y) : page.mouse.click(p.x, p.y))
  const etape = async (titre) => {
    await page.screenshot({ path: path.join(SORTIE, `${nom}-${titre}.png`) })
    empreinte[`${nom}/${titre}`] = await lireEmpreinte(page)
    verifier((await debordement(page)) <= 0, `${titre} : pas de debordement horizontal`)
  }
  const { R, C } = arbre

  await page.goto(url)
  await positionEtiquette(page, R.id)
  await page.waitForTimeout(800)
  verifier(await page.isVisible('#aide'), 'racine : aide de premiere visite affichee')
  const bloom = await page.evaluate(async () => (await import('/static/scene.js')).BLOOM_ACTIF)
  verifier(bloom === !tactile, `bloom ${bloom ? 'actif' : 'coupe'} (attendu : ${tactile ? 'coupe sur telephone' : 'actif sur bureau'})`)
  await verifierDecor(page, tactile)
  await etape('1-racine')

  await viser(await positionEtiquette(page, R.id))
  await page.waitForTimeout(PAUSE_VOL)
  let fil = await filAriane(page)
  verifier(fil.at(-1) === R.titre, `ouvrir « ${R.titre} » par son etiquette (fil : ${fil.join(' › ')})`)
  verifier(!(await page.isVisible('#aide')), 'aide masquee une fois une note ouverte')
  const roles = await page.evaluate(async ([r, filles]) => {
    const s = await import('/static/scene.js')
    return { ouverte: s.noeud(r).role, filles: filles.map((id) => s.noeud(id)?.role) }
  }, [R.id, arbre.fillesR])
  verifier(roles.ouverte === 'ouverte' && roles.filles.every((x) => x === 'enfant'), `roles apres ouverture : ouverte + ${roles.filles.length} enfant(s)`)
  await page.waitForFunction(() => window.__m.ambiance.etat().facteurContexte <= 0.51, null, { timeout: 20000 })
  const calme = await page.evaluate(async () => (await import('/static/scene.js')).ambiance.etat().facteurContexte)
  verifier(calme < 0.6, `decor : plus discret quand une note est ouverte (facteur ${calme.toFixed(2)})`)
  await etape('2-ouverte')

  if (C) {
    // Doigt : 8 px a cote de la bille (tolerance de visee). Souris : en plein centre.
    const b = await positionBille(page, C.id)
    await viser(tactile ? { x: b.x + 8, y: b.y + 5 } : b)
    await page.waitForTimeout(PAUSE_VOL)
    fil = await filAriane(page)
    verifier(fil.at(-1) === C.titre, `ouvrir « ${C.titre} » par sa bille${tactile ? ' (8 px a cote)' : ''}`)
    const anc = await page.evaluate(async (r) => { const n = (await import('/static/scene.js')).noeud(r); return [n.role, n.bille.visible] }, R.id)
    verifier(anc[0] === 'ancetre' && anc[1] === false, 'ancetre sans bille (pas de grand disque)')
    verifier(!(await page.isVisible('#ligne-lien-note')), 'note manuelle : pas de lien « Voir sur le site »')
    await etape('3-fille')

    if (tactile) await page.tap('#bouton-remonter')
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(PAUSE_VOL)
    fil = await filAriane(page)
    verifier(fil.at(-1) === R.titre, `remonter (${tactile ? 'bouton' : 'Echap'})`)
  }

  if (f.viewport.width <= 560) {
    const hauteur = () => page.evaluate(() => document.querySelector('#panneau-note').getBoundingClientRect().height)
    const avant = await hauteur()
    await page.tap('#bouton-replier')
    await page.waitForTimeout(1200)
    const apres = await hauteur()
    verifier(apres < avant / 2 && (await page.getAttribute('#bouton-replier', 'aria-expanded')) === 'false', `replier le panneau (${Math.round(avant)} → ${Math.round(apres)} px)`)
    await etape('4-replie')
    await page.tap('#bouton-replier')
    await page.waitForTimeout(600)
  }

  // La liste se met a jour a chaque frappe : attendre le resultat qui porte
  // EXACTEMENT ce titre (le premier visible peut venir d'un debut de saisie),
  // puis le choisir au doigt, ou au clavier (fleches + Entree) a la souris.
  const ouvrirParRecherche = async (titre) => {
    await (tactile ? page.tap('#champ-recherche') : page.click('#champ-recherche'))
    await page.keyboard.press('Control+A')
    await page.keyboard.type(titre)
    const rang = await page
      .waitForFunction(
        (t) => {
          const i = [...document.querySelectorAll('#resultats li[data-i]')].findIndex((l) => l.querySelector('.resultat-titre')?.textContent === t)
          return i >= 0 ? i + 1 : null
        },
        titre,
        { timeout: 10_000 }
      )
      .then(async (h) => (await h.jsonValue()) - 1)
    if (tactile) await page.tap(`#resultats li[data-i]:nth-child(${rang + 1})`)
    else {
      await page.keyboard.press('ArrowDown', { delay: 20 })
      for (let i = 0; i < rang; i++) await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
    }
    // Vol multi-niveaux : sa duree depend de la profondeur et de la vitesse de
    // rendu (bloom en rendu logiciel a 1440 px) ; on attend l'arrivee, pas un delai fixe.
    await page
      .waitForFunction((t) => document.querySelector('#fil-ariane li:last-child')?.textContent.trim() === t, titre, { timeout: 15_000 })
      .catch(() => {}) // le controle qui suit dira ou la navigation s'est arretee
    await page.waitForTimeout(PAUSE_VOL)
  }

  if (C) {
    await ouvrirParRecherche(C.titre)
    fil = await filAriane(page)
    verifier(fil.at(-1) === C.titre, `recherche « ${C.titre} » (${tactile ? 'tap' : 'clavier'})`)
    await etape('5-recherche')
  }

  // Note issue du site : son lien vers la page d'origine s'affiche dans le panneau.
  if (arbre.S) {
    await ouvrirParRecherche(arbre.S.titre)
    const lien = await page.evaluate(() => {
      const ligne = document.querySelector('#ligne-lien-note')
      return ligne.hidden ? null : document.querySelector('#lien-note').href
    })
    fil = await filAriane(page)
    verifier(lien === arbre.S.lien && fil.at(-1) === arbre.S.titre, `note du site « ${arbre.S.titre} » : lien vers ${lien ?? 'rien'} (fil : ${fil.join(' › ')})`)
    await etape('6-note-du-site')
  }

  verifier(erreurs.length === 0, `aucune erreur console${erreurs.length ? ' : ' + erreurs.join(' | ') : ''}`)
  await ctx.close()
}

/**
 * Une racine R et une de ses filles C, de preference une C qui a elle-meme des
 * filles : le parcours exerce alors tous les roles (ouverte, enfant, petit,
 * voisin, ancetre), donc l'empreinte couvre tous les reglages de apparence.js#ROLES.
 */
async function lireArbre(url) {
  const enfants = async (id) => (await (await fetch(`${url}/api/notes/${id ?? 'root'}`)).json()).children
  // Premiere note issue du site (racine « Sur le site » › groupe › contenu), s'il y en a.
  let S = null
  const surLeSite = (await enfants(null)).find((n) => n.source === 'site:racine')
  const groupe = surLeSite && (await enfants(surLeSite.id))[0]
  const contenu = groupe && (await enfants(groupe.id))[0]
  if (contenu?.lien) S = { titre: contenu.titre, lien: contenu.lien }
  const avecS = (arbre) => ({ ...arbre, S })
  let repli = null
  // Parcours principal sur les notes manuelles : la branche du site a son propre contrôle.
  const manuelles = (await enfants(null)).filter((n) => !n.source)
  for (const R of manuelles) {
    const filles = await enfants(R.id)
    if (!filles.length) continue
    const arbre = { R, C: filles[0], fillesR: filles.map((n) => n.id) }
    repli ??= arbre
    for (const C of filles) if ((await enfants(C.id)).length) return avecS({ ...arbre, C })
  }
  if (repli) return avecS(repli)
  return avecS({ R: manuelles[0], C: null, fillesR: [] })
}

function comparer(fichier) {
  const avant = JSON.parse(readFileSync(fichier, 'utf8'))
  const diffs = []
  // Seulement les etapes jouees cette fois : --formats peut en restreindre la liste.
  for (const cle of Object.keys(empreinte)) {
    const a = JSON.stringify(avant[cle]), b = JSON.stringify(empreinte[cle])
    if (a === b) continue
    for (const id of new Set([...Object.keys(avant[cle] ?? {}), ...Object.keys(empreinte[cle] ?? {})])) {
      const x = JSON.stringify(avant[cle]?.[id]), y = JSON.stringify(empreinte[cle]?.[id])
      if (x !== y) diffs.push(`${cle} note ${id} : ${x} → ${y}`)
    }
  }
  verifier(diffs.length === 0, `empreinte identique a ${path.basename(fichier)}${diffs.length ? ' :\n      ' + diffs.slice(0, 12).join('\n      ') : ''}`)
}

// --- Principal ---------------------------------------------------------------

mkdirSync(SORTIE, { recursive: true })
let navigateur
try {
  const url = option('--url') ?? (await demarrerServeur())
  const arbre = await lireArbre(url)
  console.log(`Serveur : ${url} · note testee : « ${arbre.R.titre} »${arbre.C ? ` › « ${arbre.C.titre} »` : ''}`)
  navigateur = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  })
  for (const nom of formats) await parcours(navigateur, nom, url, arbre)
  writeFileSync(path.join(SORTIE, 'empreinte.json'), JSON.stringify(empreinte, null, 1))
  if (option('--comparer')) comparer(option('--comparer'))
  // Tampon lu par le hook de fin de tache : cet etat de public/ a ete verifie en
  // local. Pas pour --url : ce serait le code de la cible, pas celui-ci.
  if (!echecs.length && !option('--url')) writeFileSync(path.join(SORTIE, 'verifie'), signatureModifs(['public']) ?? '')
} catch (erreur) {
  echecs.push(String(erreur?.stack ?? erreur))
  console.error(erreur)
} finally {
  await navigateur?.close()
  await arreterServeur()
}
console.log(echecs.length ? `\n✘ ${echecs.length} echec(s). Captures : .verif/` : '\n✔ Tout est vert. Captures : .verif/')
process.exit(echecs.length ? 1 : 0)
