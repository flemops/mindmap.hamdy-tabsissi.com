// Point d'entree : orchestre scene.js/controls.js/anim.js/recherche.js sans
// jamais faire de maths 3D lui-meme (hors appel a pointSurSphereDe /
// lonLatDepuisPoint). Vue unique de l'etat : `ouverteId`. Tout le reste
// (roles, echelles, opacites) est derive par scene.js#appliquerEtat.
import {
  attacher,
  redimensionner,
  rendu,
  horloge,
  ambiance,
  REVISION_THREE,
  ajouterNotes,
  assurerGlobe,
  appliquerEtat,
  survoler,
  noteSousPointeur,
  pointSurSphereDe,
  lonLatDepuisPoint,
  deplacerNote,
  renommerNote,
  retirerNote,
  noeud,
  estDeplie,
  enfantsDe,
  cheminIdsDe,
  sphereDe,
  directionCadrage,
} from './scene.js'
import { brancherControles, appliquerCamera, viserCible, orienterVers, reglerVol, reglerDecalage } from './controls.js'
import { dureeAnim, tween } from './anim.js'
import { brancherRecherche, invaliderIndexRecherche, ouvrirRecherche } from './recherche.js'

// Deux copies de three (scene.js + un import divergent ailleurs) donneraient
// des constructeurs Vector3/Spherical distincts et des bugs silencieux.
console.assert(REVISION_THREE === '185', 'deux copies de three ?')

const enEdition = location.pathname.startsWith('/edit')

// --- References DOM -------------------------------------------------------

const conteneur = document.getElementById('scene')
const filArianeOl = document.querySelector('#fil-ariane ol')
const champRecherche = document.getElementById('champ-recherche')
const resultats = document.getElementById('resultats')
const panneauNote = document.getElementById('panneau-note')
const hudHaut = document.getElementById('hud-haut')
const boutonFermerNote = document.getElementById('bouton-fermer-note')
const boutonReplier = document.getElementById('bouton-replier')
const aide = document.getElementById('aide')
const boutonFermerAide = document.getElementById('bouton-fermer-aide')
const titreNote = document.getElementById('titre-note')
const contenuNote = document.getElementById('contenu-note')
const ligneLienNote = document.getElementById('ligne-lien-note')
const lienNote = document.getElementById('lien-note')
const listeEnfants = document.getElementById('liste-enfants')
const compteur = document.getElementById('compteur-notes')
const boutonRemonter = document.getElementById('bouton-remonter')
const boutonDecor = document.getElementById('bouton-decor')
const annonce = document.getElementById('annonce')
const astuce = document.getElementById('astuce')
const panneau = document.getElementById('panneau-edition')
const champTitre = document.getElementById('champ-titre')
const champContenu = document.getElementById('champ-contenu')
const boutonSupprimer = document.getElementById('bouton-supprimer')
const boutonAnnuler = document.getElementById('bouton-annuler')
const boutonEnregistrer = panneau.querySelector('button[type="submit"]')
const editionSite = document.getElementById('edition-site')

// Page d'origine d'une note issue du site. La synchro (serveur) ne retient deja
// que des liens vers ce domaine ; ce filtre double la garde cote navigateur.
const SITE = 'https://hamdy-tabsissi.com/'
const lienSite = (note) => (typeof note?.lien === 'string' && note.lien.startsWith(SITE) ? note.lien : null)

if (enEdition) astuce.hidden = false

// --- Etat (vue unique) -----------------------------------------------------

let ouverteId = null // niveau ouvert, null = racine ; tout le reste en derive
let enTransition = false // un seul verrou ; les navigations concurrentes sont ignorees
let volAnnule = false // Echap pendant un vol multi-niveaux : arret propre en fin de pas
let noteEnDeplacement = null
let editionNoteId = null
let positionNouvelleNote = null
let survolDemande = null // {x, y, etiquetteId} : un seul raycast par frame, resolu dans la boucle
let noteRepliee = false // choix du visiteur sur petit ecran, garde d'une note a l'autre

// Aide de premiere visite : vue une fois (note ouverte ou aide fermee), plus
// jamais affichee. localStorage peut etre absent ou refuse (navigation privee,
// stockage bloque) : l'aide reapparait alors a chaque visite, sans erreur.
const CLE_AIDE = 'mindmap.aide-vue'
let aideVue = enEdition // /edit a deja son propre memo (#astuce)
try {
  aideVue ||= localStorage.getItem(CLE_AIDE) === '1'
} catch {}

function retenirAide() {
  if (aideVue) return
  aideVue = true
  try {
    localStorage.setItem(CLE_AIDE, '1')
  } catch {}
}

const cacheEnfants = new Map() // Map<id|null, note[]> : reponses /api/notes/:id, videe a chaque ecriture

// --- Donnees ----------------------------------------------------------------

async function chargerNote(id) {
  const rep = await fetch(id === null ? '/api/notes/root' : `/api/notes/${id}`)
  if (!rep.ok) throw new Error(`chargement note ${id} : ${rep.status}`)
  return rep.json()
}

async function appelApi(methode, url, corps) {
  const rep = await fetch(url, {
    method: methode,
    headers: { 'Content-Type': 'application/json' },
    body: corps ? JSON.stringify(corps) : undefined,
  })
  if (!rep.ok) {
    // Une session Access expiree se traduit ici par un 401/403 : recharger
    // relance le flux de connexion Cloudflare.
    if (rep.status === 401 || rep.status === 403) location.reload()
    throw new Error(`${methode} ${url} : ${rep.status}`)
  }
  return rep.status === 204 ? null : rep.json()
}

// Cache pose seulement apres succes (jamais sur un id en echec) : un echec
// reseau transitoire reste retentable au prochain appel, sans figer une
// promesse rejetee dans le cache.
function chargerEnfants(id) {
  const enfants = cacheEnfants.get(id)
  if (enfants) return Promise.resolve(enfants)
  return chargerNote(id).then(({ children }) => {
    cacheEnfants.set(id, children)
    return children
  })
}

/** A appeler apres TOUTE ecriture (POST/PUT/DELETE/PATCH). */
function invaliderCache() {
  cacheEnfants.clear()
  invaliderIndexRecherche()
}

// --- Boucle de rendu ---------------------------------------------------------

// Tolerance de visee (px) autour d'une bille que le rayon manque, selon le
// pointeur : un doigt couvre bien plus que les 6 a 10 px d'une bille sur telephone.
const TOLERANCE_VISEE = { touch: 22, pen: 8, mouse: 6 }

function resoudreNote(sx, sy, etiquetteId, typePointeur = 'mouse') {
  if (etiquetteId !== null) return noeud(Number(etiquetteId))?.note ?? null
  return noteSousPointeur(sx, sy, TOLERANCE_VISEE[typePointeur] ?? TOLERANCE_VISEE.mouse)
}

function traiterSurvol({ x, y, etiquetteId }) {
  const note = resoudreNote(x, y, etiquetteId)
  survoler(note ? note.id : null)
  conteneur.classList.toggle('sur-note', note !== null)
}

function boucle() {
  const dt = horloge.getDelta()
  const bouge = appliquerCamera(dt) // controls.update(dt) : ecrit camera.position AVANT raycast/rendu
  // Decor : plus discret quand une note est ouverte ou la recherche active (28.16).
  const decorBouge = ambiance.maj(dt, {
    calme: ouverteId !== null || document.activeElement === champRecherche || !resultats.hidden,
  })
  if (survolDemande) {
    traiterSurvol(survolDemande)
    survolDemande = null
  }
  rendu(bouge || decorBouge)
  requestAnimationFrame(boucle)
}

// --- Navigation : un seul algorithme (§7) -----------------------------------

/**
 * cibleId + chemin optionnel (fourni par la recherche, qui connait deja les
 * ids sans repasser par la scene). Compare le chemin courant au chemin vise,
 * remonte jusqu'a l'ancetre commun puis redescend : un clic sur une fille est
 * 1 descente, un clic sur un frere est 1 montee + 1 descente, etc.
 */
async function naviguerVers(cibleId, cheminIds) {
  if (enTransition) return
  enTransition = true
  volAnnule = false
  try {
    const vers = cheminIds ?? cheminIdsDe(cibleId)
    const depuis = cheminIdsDe(ouverteId)
    let c = 0
    while (c < depuis.length && c < vers.length && depuis[c] === vers[c]) c++
    const montees = depuis.length - c
    const descentes = vers.slice(c)
    const multi = montees + descentes.length > 1
    const ms = dureeAnim(multi ? 250 : 600)
    reglerVol(multi)
    for (let i = 0; i < montees && !volAnnule; i++) await remonter(ms)
    for (const id of descentes) {
      if (volAnnule) break
      await entrer(id, ms)
    }
  } catch (erreur) {
    signalerErreur("Cette note n'a pas pu être ouverte.", erreur)
  } finally {
    reglerVol(false)
    enTransition = false
    majHud()
  }
}

/** Pas atomique : precondition noeud(id).parentId === ouverteId (garanti par l'appelant). */
async function entrer(id, ms) {
  // Lance sans attendre : le reseau avance en parallele du tween, les filles
  // arrivent cachees (ajouterNotes ne pose aucun role).
  const pEnfants = estDeplie(id) ? null : chargerEnfants(id).then((enfants) => ajouterNotes(id, enfants))
  assurerGlobe(id) // grille + verre crees si absents, echelle de depart, opacites 0
  const { centre, rayon } = sphereDe(id)
  viserCible(centre, rayon, ms > 0) // promesse non attendue : le tween a lui seul une duree fixe
  orienter(id, ms > 0) // filles deja connues : face camera ; sinon, au moins dos au parent
  const depuis = ouverteId
  ouverteId = id
  // Filles inconnues au depart : on se reoriente des leur arrivee, en plein vol
  // (camera-controls enchaine sans a-coup). Attendre la fin du tween donnait un
  // second balayage une fois le vol fini, pendant lequel un tap ratait sa cible.
  // Le rejet est signale par le Promise.all ci-dessous, pas ici.
  pEnfants?.then(() => { if (ouverteId === id) orienter(id, ms > 0) }, () => {})
  majHud() // fil d'ariane et panneau immediats, la scene suit
  decaler(rayon, ms > 0) // APRES majHud : le decalage depend de la hauteur du panneau
  await Promise.all([tween(ms, (p) => appliquerEtat(depuis, id, p)), pEnfants])
  appliquerEtat(id, id, 1) // verrouille les visible=false, pose les roles des filles arrivees
  annoncer()
  precharger(id)
}

async function remonter(ms) {
  const id = ouverteId
  const parent = noeud(id).parentId
  const { centre, rayon } = sphereDe(parent)
  viserCible(centre, rayon, ms > 0)
  orienter(parent, ms > 0)
  ouverteId = parent
  majHud()
  decaler(rayon, ms > 0)
  await tween(ms, (p) => appliquerEtat(id, parent, p))
  appliquerEtat(parent, parent, 1)
  annoncer()
}

/** Tourne la camera vers les filles de `id` ; sans direction nette, ne fait rien. */
function orienter(id, animer) {
  const direction = directionCadrage(id)
  if (direction) orienterVers(direction, animer)
}

/**
 * Centre le globe dans ce que le HUD laisse libre. Sous 560 px, le panneau de note
 * (ou, a la racine, le HUD seul) est empile en bas de l'ecran ; au-dela, rien ne
 * recouvre le centre et controls.js n'applique aucun decalage.
 */
function decaler(rayon, animer) {
  const haut = (panneauNote.hidden ? hudHaut : panneauNote).getBoundingClientRect().top
  reglerDecalage(rayon, haut, animer)
}

/**
 * Fire-and-forget : fait apparaitre les petits-enfants (tier .72rem) sans
 * bloquer le verrou de navigation. Lit `ouverteId` au moment ou elle se
 * termine (pas l'id capture) : idempotente, elle applique la verite courante
 * meme si l'utilisateur a deja navigue ailleurs entre-temps.
 */
function precharger(id) {
  Promise.all(
    enfantsDe(id)
      .filter((n) => !n.deplie)
      .map((n) => chargerEnfants(n.note.id).then((enfants) => ajouterNotes(n.note.id, enfants)))
  ).then(() => appliquerEtat(ouverteId, ouverteId, 1))
}

// --- HUD : fil d'ariane, panneau note, annonce, erreurs ---------------------

function focusFilAriane() {
  filArianeOl.querySelector('[aria-current]')?.focus()
}

function ligneBouton(id, titre) {
  const li = document.createElement('li')
  const bouton = document.createElement('button')
  bouton.type = 'button'
  bouton.dataset.id = id === null ? '' : String(id)
  bouton.textContent = titre
  li.appendChild(bouton)
  return li
}

/** Reconstruit le fil d'ariane et le panneau depuis `ouverteId` : seule source de verite. */
function majHud() {
  filArianeOl.textContent = ''
  filArianeOl.appendChild(ligneBouton(null, 'RACINE'))
  for (const id of cheminIdsDe(ouverteId)) filArianeOl.appendChild(ligneBouton(id, noeud(id).note.titre))
  filArianeOl.lastElementChild.firstElementChild.setAttribute('aria-current', 'page')
  // Le fil defile horizontalement (barre masquee) : on le cale sur la note
  // ouverte, sinon le dernier maillon est coupe des le 4e niveau.
  filArianeOl.scrollLeft = filArianeOl.scrollWidth

  const seraCachee = ouverteId === null
  // Ouvrir une note, c'est avoir compris le geste : l'aide ne revient plus.
  if (!seraCachee) retenirAide()
  aide.hidden = !seraCachee || aideVue
  // Focus rendu AVANT de masquer un panneau qui le contient : sinon le focus
  // tombe dans le vide (aucun element suivant a activer au clavier).
  if (seraCachee && !panneauNote.hidden && panneauNote.contains(document.activeElement)) focusFilAriane()
  panneauNote.hidden = seraCachee
  boutonRemonter.hidden = seraCachee
  if (seraCachee) return

  const note = noeud(ouverteId).note
  const filles = enfantsDe(ouverteId)
  titreNote.textContent = note.titre
  contenuNote.textContent = note.contenu || '(pas de contenu)'
  const lien = lienSite(note)
  ligneLienNote.hidden = !lien
  if (lien) lienNote.href = lien
  listeEnfants.textContent = ''
  for (const n of filles) listeEnfants.appendChild(ligneBouton(n.note.id, n.note.titre))
  compteur.textContent = compterNotes(filles.length)
}

const compterNotes = (n) => `${n} note${n > 1 ? 's' : ''} à l'intérieur`

function annoncer() {
  if (ouverteId === null) {
    annonce.textContent = "Vue d'ensemble"
    return
  }
  const note = noeud(ouverteId).note
  annonce.textContent = `Note ouverte : ${note.titre}, ${compterNotes(enfantsDe(ouverteId).length)}`
}

/** Un echec doit se voir : sinon la page reste noire ou inerte sans explication. */
function signalerErreur(message, erreur) {
  console.error(message, erreur)
  titreNote.textContent = 'Erreur'
  contenuNote.textContent = `${message} Rechargez la page pour réessayer.`
  compteur.textContent = ''
  listeEnfants.textContent = ''
  panneauNote.hidden = false
  boutonRemonter.hidden = true
}

// Delegation : les boutons sont recrees a chaque majHud, un ecouteur par
// bouton fuirait et perdrait ceux d'avant le premier rendu.
filArianeOl.addEventListener('click', (e) => {
  const bouton = e.target.closest('button[data-id]')
  if (!bouton) return
  // data-id="" pour la racine : Number('') vaudrait 0, jamais un id valide.
  naviguerVers(bouton.dataset.id === '' ? null : Number(bouton.dataset.id))
})
listeEnfants.addEventListener('click', (e) => {
  const bouton = e.target.closest('button[data-id]')
  if (bouton) naviguerVers(Number(bouton.dataset.id))
})
boutonFermerNote.addEventListener('click', () => naviguerVers(null))
boutonReplier.addEventListener('click', () => {
  noteRepliee = !noteRepliee
  appliquerRepli()
  if (ouverteId !== null) decaler(sphereDe(ouverteId).rayon, true) // le panneau a change de hauteur
})
boutonFermerAide.addEventListener('click', () => {
  retenirAide()
  if (aide.contains(document.activeElement)) focusFilAriane()
  aide.hidden = true
})

function appliquerRepli() {
  panneauNote.classList.toggle('panneau--replie', noteRepliee)
  boutonReplier.setAttribute('aria-expanded', String(!noteRepliee))
  boutonReplier.setAttribute('aria-label', noteRepliee ? 'Afficher la note' : 'Réduire la note')
  boutonReplier.textContent = noteRepliee ? '▴' : '▾'
}
boutonRemonter.addEventListener('click', () => {
  if (ouverteId !== null) naviguerVers(noeud(ouverteId).parentId)
})

// --- Gestes (crochets de controls.js) ---------------------------------------

const crochets = {
  estGlisserNote(sx, sy, etiquetteId, typePointeur) {
    if (!enEdition) return false
    const note = resoudreNote(sx, sy, etiquetteId, typePointeur)
    if (!note) return false
    noteEnDeplacement = note
    return true
  },

  surGlisserNote(sx, sy) {
    const n = noeud(noteEnDeplacement.id)
    const point = pointSurSphereDe(n.parentId, sx, sy)
    if (!point) return
    const { lon, lat } = lonLatDepuisPoint(point, sphereDe(n.parentId).centre)
    noteEnDeplacement.x = lon
    noteEnDeplacement.y = lat
    deplacerNote(noteEnDeplacement.id, lon, lat)
  },

  async surFinGlisserNote(aBouge) {
    const note = noteEnDeplacement
    noteEnDeplacement = null
    if (!note) return
    if (aBouge) {
      await appelApi('PATCH', `/api/write/notes/${note.id}/position`, { x: note.x, y: note.y })
      invaliderCache()
    } else {
      naviguerVers(note.id) // immobile = un clic : ouvrir la note plutot que la deplacer
    }
  },

  surClic(sx, sy, etiquetteId, typePointeur) {
    // L'etiquette de la note ouverte ne mene nulle part (on y est deja) et, en
    // gros caracteres, recouvre parfois la bille d'une fille : on vise dessous.
    if (etiquetteId !== null && Number(etiquetteId) === ouverteId) etiquetteId = null
    const note = resoudreNote(sx, sy, etiquetteId, typePointeur)
    if (note) naviguerVers(note.id)
  },

  surSurvol(sx, sy, etiquetteId) {
    survolDemande = { x: sx, y: sy, etiquetteId } // resolu dans boucle() : un raycast max par frame
  },

  surClicDroit(sx, sy, etiquetteId) {
    if (!enEdition) return
    const note = resoudreNote(sx, sy, etiquetteId)
    if (note) ouvrirPanneauEdition(note)
  },

  surDoubleClicVide(sx, sy, etiquetteId) {
    if (!enEdition) return
    if (resoudreNote(sx, sy, etiquetteId)) return
    // La branche « Sur le site » appartient a la synchro : le serveur refuserait (409).
    if (ouverteId !== null && noeud(ouverteId).note.source) return
    // La nouvelle note se pose sur la sphere du niveau actuellement ouvert.
    const point = pointSurSphereDe(ouverteId, sx, sy)
    if (!point) return
    positionNouvelleNote = lonLatDepuisPoint(point, sphereDe(ouverteId).centre)
    ouvrirPanneauEdition(null)
  },
}

// --- Edition (mode /edit) ----------------------------------------------------

function ouvrirPanneauEdition(note) {
  editionNoteId = note ? note.id : null
  champTitre.value = note ? note.titre : ''
  champContenu.value = note ? note.contenu : ''
  // Note issue du site : lecture seule ici (le serveur refuserait de toute facon).
  const site = Boolean(note?.source)
  champTitre.disabled = champContenu.disabled = boutonEnregistrer.disabled = site
  editionSite.hidden = !site
  boutonSupprimer.hidden = !note || site
  panneau.hidden = false
  ;(site ? boutonAnnuler : champTitre).focus()
}

function fermerPanneauEdition() {
  if (panneau.contains(document.activeElement)) focusFilAriane()
  panneau.hidden = true
  editionNoteId = null
  positionNouvelleNote = null
}

boutonAnnuler.addEventListener('click', fermerPanneauEdition)

panneau.addEventListener('submit', async (e) => {
  e.preventDefault()
  const titre = champTitre.value.trim()
  if (!titre) return
  const contenu = champContenu.value

  if (editionNoteId !== null) {
    const maj = await appelApi('PUT', `/api/write/notes/${editionNoteId}`, { titre, contenu })
    renommerNote(maj) // met a jour n.note + le texte de l'etiquette, sans retirer/reposer
  } else {
    const pos = positionNouvelleNote ?? { lon: 0, lat: 0 }
    const creee = await appelApi('POST', '/api/write/notes', {
      parent_id: ouverteId,
      titre,
      contenu,
      x: pos.lon,
      y: pos.lat,
    })
    ajouterNotes(ouverteId, [creee])
    appliquerEtat(ouverteId, ouverteId, 1)
  }
  invaliderCache()
  majHud()
  fermerPanneauEdition()
})

boutonSupprimer.addEventListener('click', async () => {
  if (editionNoteId === null) return
  if (!confirm('Supprimer cette note et toutes ses notes filles ?')) return
  const id = editionNoteId
  await appelApi('DELETE', `/api/write/notes/${id}`)
  // Si la note ouverte est supprimee (ou un de ses ancetres), il faut en
  // sortir AVANT de la retirer : sinon noeud(ouverteId) devient indefini au
  // milieu du pas de navigation.
  if (ouverteId === id || cheminIdsDe(ouverteId).includes(id)) await naviguerVers(noeud(id).parentId)
  retirerNote(id) // recursif sur les filles
  invaliderCache()
  majHud()
  fermerPanneauEdition()
})

// --- Recherche + clavier global ----------------------------------------------

brancherRecherche({
  champ: champRecherche,
  liste: resultats,
  chargerEnfants,
  surChoix: (entree) => naviguerVers(entree.id, entree.ids),
  surFermeture: focusFilAriane,
})

window.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const cible = document.activeElement
    const enSaisie = cible && (cible.tagName === 'INPUT' || cible.tagName === 'TEXTAREA' || cible.isContentEditable)
    if (!enSaisie) {
      e.preventDefault()
      ouvrirRecherche()
      return
    }
  }
  // Chaine unique : le champ de recherche a deja consomme son propre Echap
  // (stopPropagation dans recherche.js) avant que celui-ci ne s'execute.
  if (e.key === 'Escape') {
    if (!panneau.hidden) fermerPanneauEdition()
    else if (enTransition) volAnnule = true
    else if (ouverteId !== null) naviguerVers(noeud(ouverteId).parentId)
  }
})

// --- Depart -------------------------------------------------------------------

// Bouton du decor : coupe le mouvement (comme prefers-reduced-motion) sans retirer le decor.
function majBoutonDecor() {
  const impose = ambiance.imposeParLeSysteme()
  boutonDecor.setAttribute('aria-pressed', String(ambiance.mouvementActif()))
  boutonDecor.setAttribute('aria-disabled', String(impose))
  boutonDecor.title = impose
    ? 'Mouvement du décor coupé par la préférence « réduire les animations » de votre système'
    : 'Mouvement du décor (étoiles qui scintillent, étoiles filantes, vaisseaux)'
}
boutonDecor.addEventListener('click', () => {
  if (ambiance.imposeParLeSysteme()) return
  ambiance.basculerMouvement()
  majBoutonDecor()
})
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', majBoutonDecor)
majBoutonDecor()

attacher(conteneur)
redimensionner()
brancherControles(conteneur, crochets)
viserCible(sphereDe(null).centre, sphereDe(null).rayon, false)
window.addEventListener('resize', () => {
  redimensionner()
  // Le HUD a pu passer en bas (ou en sortir) et le panneau changer de hauteur :
  // sans ceci, le globe gardait jusqu'a la navigation suivante un decalage faux.
  decaler(sphereDe(ouverteId).rayon, true)
})
// Portrait <-> paysage : le cadrage depend du champ horizontal (distanceCadrage),
// on recadre le globe ouvert. Pas a chaque resize : un simple redimensionnement
// de fenetre ne doit pas annuler le zoom que le visiteur a choisi.
matchMedia('(orientation: portrait)').addEventListener('change', () => {
  const { centre, rayon } = sphereDe(ouverteId)
  viserCible(centre, rayon, true)
  decaler(rayon, true) // APRES : fitToSphere remet le decalage vertical a zero
})
requestAnimationFrame(boucle)

async function demarrer() {
  try {
    const enfants = await chargerEnfants(null)
    ajouterNotes(null, enfants)
    appliquerEtat(null, null, 1)
    orienter(null, false) // premiere vue : les notes de premier niveau face a la camera
    // Donnees seules, rien d'affiche : la premiere note ouverte connait deja ses
    // filles et la camera s'oriente vers elles en un seul mouvement, meme quand le
    // reseau mobile les livrerait apres la fin du vol. Un echec se rejoue a l'ouverture.
    for (const note of enfants) chargerEnfants(note.id).catch(() => {})
  } catch (erreur) {
    signalerErreur("Les notes n'ont pas pu être chargées.", erreur)
  } finally {
    majHud()
    decaler(sphereDe(null).rayon, false)
  }
}
demarrer()
