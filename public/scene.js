// Scene 3D : un seul monde continu, hierarchique. Les notes de premier niveau
// sont posees sur un globe ; ouvrir une note fait naitre, autour d'elle, un
// globe plus petit (grille + verre) qui porte ses filles. Rien n'est retire
// lors d'une navigation : le monde grandit autour de ce qu'on ouvre.
//
// La hierarchie de groupes EST la geometrie : chaque note est une `ancre`
// posee en coordonnees unite (lon, lat) dans le `niveau` de son parent, et
// possede son propre `niveau` (echelle MONDE.facteurNiveau). Deplacer une note
// deplace ses filles gratuitement ; ouvrir un globe = un simple scale local.
// Les groupes sont translates/scales, jamais tournes : la normale locale
// d'une ancre (= sa position unite) est aussi sa normale monde.
//
// Tout etat visuel derive de l'id ouvert (appliquerEtat) ; ce fichier ne
// connait ni l'API HTTP ni le HUD. Toute mutation visuelle passe ici et pose
// le drapeau `sale`, ce qui permet a rendu() de ne dessiner qu'a la demande.
//
// Aucune lumiere : materiaux "basic", la scene est un trace lisible et peu
// couteux. Pas de tone mapping : #0f1115, #9c9ba6, #e6b450 font l'aller-retour
// sRGB -> lineaire -> sortie a l'identique, donc parite exacte avec le CSS.
import * as THREE from './vendor/three-0.185.1/build/three.module.min.js'
import { CSS2DRenderer, CSS2DObject } from './vendor/three-0.185.1/examples/jsm/renderers/CSS2DRenderer.js'
import { EffectComposer } from './vendor/three-0.185.1/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from './vendor/three-0.185.1/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from './vendor/three-0.185.1/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from './vendor/three-0.185.1/examples/jsm/postprocessing/OutputPass.js'
// Tous les reglages visuels (couleurs, tailles, opacites par role, globes, bloom,
// camera) : apparence.js. Ce fichier n'en garde que la mecanique.
import { COULEURS, MONDE, LUEUR, GLOBES, ROLES, SURVOL, ETIQUETTES, ETOILES, CAMERA } from './apparence.js'
import { creerAmbiance } from './ambiance.js'

/** Garde anti "deux copies de three" : app.js compare a '185'. */
export const REVISION_THREE = THREE.REVISION

const AMBRE = new THREE.Color(COULEURS.ambre)
const FOND = new THREE.Color(COULEURS.fond)

/** Rayon du globe de profondeur `prof` (0 = racine). */
const rayonNiveau = (prof) => MONDE.rayonGlobe * MONDE.facteurNiveau ** prof
const lerp = THREE.MathUtils.lerp

// ---------------------------------------------------------------------------
// Scene, camera, renderer, bloom
// ---------------------------------------------------------------------------

export const scene = new THREE.Scene()
// Color (alpha 1) et non transparent : un canvas alpha casserait la parite
// des couleurs avec le CSS (#0f1115 deviendrait #020305).
scene.background = new THREE.Color(COULEURS.fond)

// far 4000 : les etoiles vivent entre 1400 et 2500.
export const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 4000)
// THREE.Clock est deprecie depuis peu (avertissement console a l'instanciation,
// remplacement recommande : THREE.Timer, un addon non vendore ici). Seul usage
// reel : getDelta() dans la boucle de app.js -- un chrono minimal maison evite
// l'avertissement sans tirer de nouveau fichier vendor pour un besoin d'une ligne.
export const horloge = {
  precedent: performance.now(),
  getDelta() {
    const maintenant = performance.now()
    const delta = (maintenant - this.precedent) / 1000
    this.precedent = maintenant
    return delta
  },
}

const pixelRatio = () => Math.min(devicePixelRatio, 2)

// Le bloom exige un rendu en flottant : sans EXT_color_buffer_float (certains
// GPU mobiles) le framebuffer serait incomplet. Repli : rendu direct avec
// l'antialias natif, le halo sprite reste seul a suggerer la lueur. Sur
// telephone il est coupe d'office (cout, voir apparence.js#LUEUR).
// `?sansbloom` / `?avecbloom` forcent l'un ou l'autre pour comparer a l'oeil.
const estTelephone =
  matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < LUEUR.petitCoteTelephone
let renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
const bloomPossible =
  renderer.capabilities.isWebGL2 &&
  renderer.extensions.has('EXT_color_buffer_float') &&
  !location.search.includes('sansbloom') &&
  (!estTelephone || LUEUR.surTelephone || location.search.includes('avecbloom'))
/** Lu par scripts/verifier.mjs : bloom coupe sur telephone, actif sur bureau. */
export const BLOOM_ACTIF = bloomPossible
if (!bloomPossible) {
  renderer.forceContextLoss()
  renderer.dispose()
  renderer = new THREE.WebGLRenderer({ antialias: true })
}
// AVANT le composer : EffectComposer lit le ratio une fois a sa construction.
renderer.setPixelRatio(pixelRatio())
renderer.toneMapping = THREE.NoToneMapping

let composer = null
if (bloomPossible) {
  // 4 echantillons a 3840×2160 en RGBA16F ≈ 465 Mo, inacceptable ; 2 ≈ 230 Mo.
  const samples = pixelRatio() > 1.5 ? 2 : 4
  const cible = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples })
  composer = new EffectComposer(renderer, cible)
  // OBLIGATOIRE avec une cible fournie : sinon ses dimensions (1×1) sont
  // prises pour la taille logique.
  composer.setSize(innerWidth, innerHeight)
  composer.addPass(new RenderPass(scene, camera))
  // Reglages et seuil : apparence.js#LUEUR. La resolution passee ici est
  // ecrasee par composer.setSize.
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), LUEUR.force, LUEUR.rayon, LUEUR.seuil))
  composer.addPass(new OutputPass())
}

// Cree dans attacher() : le calque #etiquettes doit exister dans le DOM.
let labelRenderer = null

// Decor spatial (ambiance.js) : hors graphe de notes, hors raycast. app.js lui donne le temps.
export const ambiance = creerAmbiance(scene, camera, { telephone: estTelephone })

const raycaster = new THREE.Raycaster()

// Drapeau « sale » : toute mutation visuelle de ce fichier le pose, rendu() ne
// dessine que s'il est pose ou si la camera a bouge (13 passes plein ecran a
// dpr 2 coutent cher en batterie).
let sale = true
export function marquerSale() {
  sale = true
}

// ---------------------------------------------------------------------------
// Ressources partagees : creees une fois, jamais disposees
// ---------------------------------------------------------------------------

const GEO_UNITE = new THREE.SphereGeometry(1, 16, 12)
const GEO_VERRE = new THREE.SphereGeometry(1, 32, 24)
const GEO_GRILLE = grilleSpherique()
const TEX_HALO = textureHalo()

/** (lon, lat) en degres -> point sur la sphere unite. Sans clamp (grille). */
function pointUnite(lonDeg, latDeg) {
  const phi = THREE.MathUtils.degToRad(90 - latDeg)
  const theta = THREE.MathUtils.degToRad(lonDeg)
  return new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  )
}

/** Position unite d'une note : latitude bornee a ±85° pour eviter les poles. */
function positionNote(lonDeg, latDeg) {
  return pointUnite(lonDeg, Math.max(-85, Math.min(85, latDeg)))
}

/**
 * Grille unite en LineSegments : 12 meridiens (demi-grands-cercles tous les
 * 30°) et 5 paralleles (0, ±30, ±60), 64 segments chacun. Contrairement a
 * `wireframe: true`, aucune diagonale de triangle : des fils fins et propres.
 */
function grilleSpherique() {
  const SEGMENTS = 64
  const points = []
  const segment = (a, b) => points.push(a.x, a.y, a.z, b.x, b.y, b.z)
  for (let m = 0; m < 12; m++) {
    const lon = m * 30
    for (let s = 0; s < SEGMENTS; s++) {
      segment(pointUnite(lon, -90 + (180 * s) / SEGMENTS), pointUnite(lon, -90 + (180 * (s + 1)) / SEGMENTS))
    }
  }
  for (const lat of [-60, -30, 0, 30, 60]) {
    for (let s = 0; s < SEGMENTS; s++) {
      segment(pointUnite((360 * s) / SEGMENTS, lat), pointUnite((360 * (s + 1)) / SEGMENTS, lat))
    }
  }
  const geometrie = new THREE.BufferGeometry()
  geometrie.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  return geometrie
}

/**
 * Degrade radial blanc -> transparent, alpha = (1 − t)². Masque neutre : la
 * teinte vient de la couleur du SpriteMaterial (ambre), donc pas de couleur
 * hors palette a l'ecran.
 */
function textureHalo() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')
  const degrade = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    degrade.addColorStop(t, `rgba(255,255,255,${((1 - t) ** 2).toFixed(3)})`)
  }
  ctx.fillStyle = degrade
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(canvas)
}

// ---------------------------------------------------------------------------
// Graphe : etoiles, racine, noeuds
// ---------------------------------------------------------------------------

scene.add(champDEtoiles())

function champDEtoiles() {
  const nombre = ETOILES.nombre
  const positions = new Float32Array(nombre * 3)
  for (let i = 0; i < nombre; i++) {
    // Coquille lointaine : le fond bouge peu quand on orbite, effet « ciel »
    // plutot que « confettis ».
    const rayon = ETOILES.rayonMin + Math.random() * ETOILES.epaisseur
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    positions[i * 3] = rayon * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = rayon * Math.cos(phi)
    positions[i * 3 + 2] = rayon * Math.sin(phi) * Math.sin(theta)
  }
  const geometrie = new THREE.BufferGeometry()
  geometrie.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  // NormalBlending, jamais Additive : des etoiles additives s'empileraient en
  // points blancs qui franchiraient le seuil du bloom.
  return new THREE.Points(
    geometrie,
    new THREE.PointsMaterial({
      color: COULEURS.attenue,
      size: ETOILES.taille,
      sizeAttenuation: true,
      transparent: true,
      opacity: ETOILES.opacite,
      depthWrite: false,
      blending: THREE.NormalBlending,
    })
  )
}

/**
 * Tout ce que la scene connait d'une note.
 * N = { note, parentId (undefined racine, null 1er niveau), prof, sBille,
 *       ancre, bille, halo, etiquette (CSS2DObject), trait (Line|null),
 *       niveau, grille, verre (crees par assurerGlobe), deplie, role, derriere }
 * La cle `null` porte le pseudo-noeud racine (ancre null, niveau = scene).
 * @type {Map<number|null, object>}
 */
const noeuds = new Map()

// Billes touchables par le raycast (roles ≠ cache et ≠ ouverte), recalculees
// a chaque appliquerEtat : Raycaster ignore `visible`, le filtre est obligatoire.
let billesCliquables = []

const racineNiveau = new THREE.Group()
racineNiveau.scale.setScalar(MONDE.rayonGlobe)
scene.add(racineNiveau)
{
  const { grille, verre } = creerGlobe(racineNiveau)
  noeuds.set(null, {
    note: null, parentId: undefined, prof: 0, sBille: 0,
    ancre: null, bille: null, halo: null, etiquette: null, trait: null,
    niveau: racineNiveau, grille, verre, deplie: false, role: 'ouverte', derriere: false,
    genee: false, taille: null,
  })
}

/**
 * Grille + verre unite d'un niveau. Le verre est transparent, depthWrite false,
 * dessine apres grille/traits/billes (renderOrder 2) : ce qui est devant sa face
 * avant reste net, ce qui est derriere est recouvert a 55 % de fond, sans jamais
 * former de mur invisible (rien n'est rejete par le depth buffer).
 */
function creerGlobe(niveau) {
  const grille = new THREE.LineSegments(
    GEO_GRILLE,
    new THREE.LineBasicMaterial({ color: COULEURS.attenue, transparent: true, opacity: GLOBES.ouvert.grille, depthWrite: true })
  )
  grille.renderOrder = 1
  const verre = new THREE.Mesh(
    GEO_VERRE,
    new THREE.MeshBasicMaterial({
      color: COULEURS.fond, transparent: true, opacity: GLOBES.ouvert.verre, depthWrite: false, side: THREE.FrontSide,
    })
  )
  // Legerement sous la grille : les fils restent nets devant le voile.
  verre.scale.setScalar(GLOBES.retraitVerre)
  verre.renderOrder = 2
  niveau.add(grille, verre)
  return { grille, verre }
}

/** Trait du centre du globe parent a l'ancre (coordonnees unite du niveau). */
function creerTrait(positionAncre) {
  const geometrie = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), positionAncre.clone()])
  const trait = new THREE.Line(
    geometrie,
    new THREE.LineBasicMaterial({ color: COULEURS.ambre, transparent: true, opacity: 0, depthWrite: true })
  )
  trait.renderOrder = 1
  // La geometrie est mise a jour en place par deplacerNote : pas de sphere
  // englobante a maintenir.
  trait.frustumCulled = false
  trait.visible = false
  return trait
}

// ---------------------------------------------------------------------------
// Attache, taille, rendu
// ---------------------------------------------------------------------------

/**
 * `conteneur` = #scene, qui contient deja le calque #etiquettes. Le canvas est
 * insere AVANT lui pour que les etiquettes se superposent au rendu.
 */
export function attacher(conteneur) {
  conteneur.insertBefore(renderer.domElement, conteneur.firstChild)
  labelRenderer = new CSS2DRenderer({ element: document.getElementById('etiquettes') })
  redimensionner()
}

export function redimensionner() {
  const w = innerWidth, h = innerHeight, r = pixelRatio()
  if (r !== renderer.getPixelRatio()) {
    renderer.setPixelRatio(r)
    composer?.setPixelRatio(r)
  }
  // Pixels CSS partout : le composer et le renderer multiplient eux-memes par
  // le ratio ; le CSS2DRenderer projette en px logiques (sinon translate(NaN)).
  renderer.setSize(w, h)
  composer?.setSize(w, h)
  labelRenderer?.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  ambiance.redimensionner()
  marquerSale()
}

/** Dessine si la scene est sale ou si la camera a bouge ; sinon ne fait rien. */
export function rendu(cameraBouge) {
  if (!sale && !cameraBouge) return
  sale = false
  majEtiquettesDos()
  composer ? composer.render() : renderer.render(scene, camera)
  labelRenderer?.render(scene, camera)
  // Apres le rendu : les matrices monde et la projection sont a jour.
  majEtiquettesGenees()
}

/**
 * Distance a laquelle une sphere tient dans le cadre. En portrait c'est le champ
 * horizontal qui contraint : une distance fixe y sortirait les notes du cadre.
 */
export function distanceCadrage(rayon = MONDE.rayonGlobe, marge = CAMERA.margeCadrage) {
  const champVertical = THREE.MathUtils.degToRad(camera.fov)
  const champHorizontal = 2 * Math.atan(Math.tan(champVertical / 2) * camera.aspect)
  // sin, pas tan : c'est la formule de getDistanceToFitSphere (camera-controls,
  // l.1972 du module vendorise) que fitToSphere appelle reellement. Un tan ici
  // donnerait une distance ≈10 % trop courte (fov 50, aspect 1) : premiere pose
  // de camera trop proche, puis saut visible au premier fitToSphere.
  return (rayon * marge) / Math.sin(Math.min(champVertical, champHorizontal) / 2)
}

const _position = new THREE.Vector3()
const _vue = new THREE.Vector3()

/**
 * Test dos/face de chaque etiquette visible : la normale de l'ancre (= sa
 * position unite, groupes sans rotation) contre la direction vers la camera.
 * La note ouverte n'est jamais « derriere » : on la regarde de face.
 */
function majEtiquettesDos() {
  for (const n of noeuds.values()) {
    if (!n.ancre || !n.ancre.visible) continue
    let derriere = false
    if (n.role !== 'ouverte') {
      n.ancre.getWorldPosition(_position)
      derriere = n.ancre.position.dot(_vue.subVectors(camera.position, _position)) < 0
    }
    if (derriere !== n.derriere) {
      n.derriere = derriere
      n.etiquette.element.classList.toggle('etiquette--derriere', derriere)
    }
  }
}

// Priorites, marges : apparence.js#ETIQUETTES.
const _ecran = new THREE.Vector3()
const _boites = []

/**
 * Collisions d'etiquettes. Les boites sont calculees par projection (meme calcul
 * que le CSS2DRenderer : centre bas de l'etiquette pose sur le point projete),
 * sans lire la mise en page a chaque image ; seule la taille de l'element est
 * lue, puis gardee tant que sa classe de role ne change pas. Parcours glouton
 * par priorite decroissante : une etiquette qui recouvre une etiquette deja
 * posee recoit `etiquette--genee` (attenuee ou masquee par la CSS, jamais
 * retiree : le survol de sa bille la revele, et la liste du panneau reste la
 * voie fiable).
 */
function majEtiquettesGenees() {
  if (!labelRenderer) return
  const w = innerWidth, h = innerHeight
  _boites.length = 0
  for (const n of noeuds.values()) {
    if (!n.ancre) continue
    const priorite = n.ancre.visible ? ETIQUETTES.priorite[n.role] : undefined
    if (priorite === undefined) {
      poserGenee(n, false)
      continue
    }
    n.etiquette.getWorldPosition(_ecran).project(camera)
    if (_ecran.z < -1 || _ecran.z > 1) {
      poserGenee(n, false)
      continue
    }
    if (!n.taille) {
      const element = n.etiquette.element
      // Largeur nulle : l'element est encore en display none (premier rendu) ;
      // on ne garde pas cette mesure, elle sera refaite a l'image suivante.
      if (element.offsetWidth === 0) continue
      n.taille = { l: element.offsetWidth, h: element.offsetHeight }
    }
    const x = (_ecran.x * 0.5 + 0.5) * w, y = (-_ecran.y * 0.5 + 0.5) * h
    // Titre qui deborderait de la fenetre : on le fait glisser le long de son
    // point d'ancrage (center.x du CSS2DObject : .5 = centre sur la bille) au
    // lieu de le laisser coupe. Applique au rendu suivant, d'ou marquerSale.
    const gauche = Math.max(ETIQUETTES.bordEcran, Math.min(x - n.taille.l / 2, w - ETIQUETTES.bordEcran - n.taille.l))
    const centre = n.taille.l >= w - 2 * ETIQUETTES.bordEcran ? 0.5 : Math.max(0, Math.min(1, (x - gauche) / n.taille.l))
    if (Math.abs(centre - n.etiquette.center.x) > 0.01) {
      n.etiquette.center.x = centre
      marquerSale()
    }
    const x0 = x - n.taille.l * n.etiquette.center.x
    _boites.push({
      n,
      rang: priorite + (n.note.id === survolId ? 8 : 0) - (n.derriere ? 1.5 : 0),
      x0: x0 + ETIQUETTES.margeBoite, x1: x0 + n.taille.l - ETIQUETTES.margeBoite,
      y0: y - n.taille.h + ETIQUETTES.margeBoite, y1: y - ETIQUETTES.margeBoite,
    })
  }
  _boites.sort((a, b) => b.rang - a.rang)
  for (let i = 0; i < _boites.length; i++) {
    const b = _boites[i]
    let genee = false
    for (let j = 0; j < i && !genee; j++) {
      const a = _boites[j]
      genee = !a.genee && b.x0 < a.x1 && a.x0 < b.x1 && b.y0 < a.y1 && a.y0 < b.y1
    }
    b.genee = genee
    poserGenee(b.n, genee)
  }
}

function poserGenee(n, genee) {
  if (genee === n.genee) return
  n.genee = genee
  n.etiquette.element.classList.toggle('etiquette--genee', genee)
}

// ---------------------------------------------------------------------------
// Construction et lecture du graphe
// ---------------------------------------------------------------------------

export function noeud(id) {
  return noeuds.get(id) ?? null
}

export function estDeplie(id) {
  return noeuds.get(id)?.deplie === true
}

export function compterEnfants(id) {
  let total = 0
  for (const n of noeuds.values()) if (n.ancre && n.parentId === id) total++
  return total
}

/** Filles directes, dans l'ordre d'insertion (celui de la Map). */
export function enfantsDe(id) {
  const filles = []
  for (const n of noeuds.values()) if (n.ancre && n.parentId === id) filles.push(n)
  return filles
}

/** Ids des ancetres puis de la note, racine exclue, du haut vers le bas. */
export function cheminIdsDe(id) {
  const chemin = []
  let courant = noeuds.get(id)
  while (courant?.ancre) {
    chemin.unshift(courant.note.id)
    courant = noeuds.get(courant.parentId)
  }
  return chemin
}

/** Profondeur : 0 pour la racine, 1 pour une note posee sur elle, etc. */
export function niveauDe(id) {
  return noeuds.get(id)?.prof ?? 0
}

/** Sphere monde du globe d'une note (rayon ferme, independant de l'animation). */
export function sphereDe(id) {
  const n = noeuds.get(id)
  const centre = n?.ancre ? n.ancre.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3()
  return { centre, rayon: rayonNiveau(niveauDe(id)) }
}

// Points de vue candidats pour cadrer un globe : azimut tous les 15°, latitude
// entre -40° et +40° (l'horizon reste lisible ; controls.js#orienterVers borne
// de toute facon l'angle polaire). 120 directions, calculees une fois. Azimuts
// decales de 7.5° : jamais dans le plan d'un meridien (multiples de 30°), qui se
// reduirait sinon a un trait vertical en plein centre du globe.
const VUES = []
for (let lon = 7.5; lon < 360; lon += 15) for (const lat of [-40, -20, 0, 20, 40]) VUES.push(pointUnite(lon, lat))
const _versCamera = new THREE.Vector3()

/**
 * Lisibilite d'une fille vue depuis une direction, selon c = vue·position :
 * - c <= .33 : au dos du globe ou sur sa tranche (rayon / distance de cadrage
 *   ≈ .33 en paysage) → 0 ;
 * - .45 a .8 : de face, a mi-chemin entre le centre et le bord → 1 ;
 * - vers 1 : plein axe, la fille passe devant la bille ouverte et son titre → .25.
 *   A la racine (`axeLibre`), aucune bille n'occupe le centre : l'axe est au
 *   contraire la meilleure place, la note est centree a l'ecran.
 */
function lisibilite(c, axeLibre) {
  if (c <= 0.33) return 0
  if (c < 0.45) return (c - 0.33) / 0.12
  if (axeLibre) return 1 + 0.3 * c
  if (c <= 0.8) return 1
  return 1 - 0.75 * ((c - 0.8) / 0.2)
}

/**
 * Direction (unitaire, monde) depuis laquelle regarder le globe de `id` pour que
 * le plus possible de ses filles soient lisibles. Les groupes ne sont jamais
 * tournes : la position unite d'une fille est aussi sa direction monde. Chaque
 * vue candidate est notee par la lisibilite de chaque fille ; a egalite, la vue
 * la plus proche de la camera actuelle l'emporte (le moins de mouvement
 * possible). Une vue placee du cote du parent est penalisee quand ce parent a une
 * bille : elle passerait entre le globe ouvert et la camera. Sans fille, on regarde depuis l'exterieur
 * du globe parent. `null` (racine vide) : l'appelant ne tourne pas.
 */
export function directionCadrage(id) {
  const n = noeuds.get(id)
  if (!n) return null
  const soi = n.ancre?.position ?? null
  // Une note de premier niveau a pour parent la racine, qui n'a pas de bille.
  const parentABille = soi !== null && n.parentId !== null
  const filles = enfantsDe(id)
  if (filles.length === 0) return soi ? soi.clone() : null

  _versCamera.copy(camera.position).sub(sphereDe(id).centre).normalize()
  let meilleure = null, meilleurScore = -Infinity
  for (const vue of VUES) {
    let score = 0.25 * vue.dot(_versCamera)
    for (const fille of filles) score += lisibilite(vue.dot(fille.ancre.position), !soi)
    if (parentABille) {
      const cote = vue.dot(soi) // < 0 : la camera serait du cote du parent
      score += 0.2 * cote - (cote < -0.2 ? 2 : 0)
    }
    if (score > meilleurScore) {
      meilleurScore = score
      meilleure = vue
    }
  }
  return meilleure.clone()
}

/**
 * Ajoute des notes sous un parent (`null` = racine). Les nouveaux noeuds
 * naissent en role `cache` (invisibles) : c'est le prochain appliquerEtat qui
 * decide de leur apparence. Les notes deja presentes ne sont pas retouchees.
 */
export function ajouterNotes(parentId, notes) {
  const parent = noeuds.get(parentId)
  if (!parent) return
  const prof = parent.prof + 1
  // Rayon monde du globe qui porte ces notes, et taille de bille associee
  // (>= 1 unite pour rester cliquable au niveau le plus profond).
  const rNiveau = rayonNiveau(parent.prof)
  const sBille = Math.max(MONDE.billeMin, rNiveau * MONDE.tailleBille) / rNiveau

  for (const note of notes) {
    if (noeuds.has(note.id)) continue

    const ancre = new THREE.Object3D()
    ancre.position.copy(positionNote(note.x, note.y))
    ancre.visible = false

    // Opaque par defaut : un MeshBasicMaterial transparent entrerait dans la
    // liste triee par distance et se battrait avec verre/traits (popping).
    // Le dimming se fait par la couleur, pas par l'opacite.
    const bille = new THREE.Mesh(GEO_UNITE, new THREE.MeshBasicMaterial({ color: FOND }))
    bille.scale.setScalar(sBille)
    bille.userData.id = note.id

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: TEX_HALO, color: COULEURS.ambre, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
      })
    )
    halo.scale.setScalar(sBille * MONDE.halo)
    halo.renderOrder = 3
    halo.visible = false

    const element = document.createElement('div')
    element.className = 'etiquette etiquette--cachee'
    element.dataset.id = String(note.id)
    element.textContent = note.titre
    const etiquette = new CSS2DObject(element)
    // Ancre en bas de l'etiquette, posee au-dessus de la bille.
    etiquette.center.set(0.5, 1)
    etiquette.position.set(0, sBille * MONDE.decalageEtiquette, 0)

    const niveau = new THREE.Group()
    niveau.scale.setScalar(MONDE.facteurNiveau)

    ancre.add(bille, halo, etiquette, niveau)
    parent.niveau.add(ancre)

    // Pas de trait au premier niveau : la racine n'a pas de coeur.
    const trait = parentId === null ? null : creerTrait(ancre.position)
    if (trait) parent.niveau.add(trait)

    noeuds.set(note.id, {
      note, parentId, prof, sBille, ancre, bille, halo, etiquette, trait,
      niveau, grille: null, verre: null, deplie: false, role: 'cache', derriere: false,
      genee: false, taille: null,
    })
  }

  parent.deplie = true
  marquerSale()
}

/** Echelle d'un globe qui « nait du point » : la grille unite vit dans `niveau`. */
function echelleDepart(id) {
  return id === null ? 1 : noeuds.get(id).sBille / MONDE.facteurNiveau
}

/**
 * Cree paresseusement grille + verre du globe d'une note, a l'echelle de depart
 * et invisibles : appliquerEtat les fera grandir. `null` = racine, deja creee.
 */
export function assurerGlobe(id) {
  const n = noeuds.get(id)
  if (!n || n.grille) return
  const { grille, verre } = creerGlobe(n.niveau)
  const s0 = echelleDepart(id)
  grille.scale.setScalar(s0)
  verre.scale.setScalar(s0 * GLOBES.retraitVerre)
  grille.material.opacity = 0
  verre.material.opacity = 0
  grille.visible = verre.visible = false
  n.grille = grille
  n.verre = verre
  marquerSale()
}

// ---------------------------------------------------------------------------
// Etats derives : roles, globes, appliquerEtat
// ---------------------------------------------------------------------------

// Apparence par role (couleur, taille, halo, trait, titre) : apparence.js#ROLES.
const CLASSES_TIER = ['etiquette--ouverte', 'etiquette--enfant', 'etiquette--petit', 'etiquette--cachee']

/**
 * Role d'un noeud pour un id ouvert `o` (null = racine). `chemin` = Set des ids
 * de cheminIdsDe(o), passe par l'appelant pour ne pas le recalculer par noeud.
 * Invariant : tout ancetre d'un noeud visible est visible (ouverte/ancetre →
 * ancetres = ancetre ; enfant/petit → ouverte/enfant ; voisin → parent(o) =
 * ancetre). Un noeud `cache` n'a donc jamais de descendant visible, ce qui rend
 * `ancre.visible = false` sur.
 */
function roleDe(n, o, chemin) {
  const id = n.note.id
  if (id === o) return 'ouverte'
  if (n.parentId === o) return 'enfant'
  // La racine a parentId undefined : jamais egal a un id ouvert.
  if (noeuds.get(n.parentId)?.parentId === o) return 'petit'
  if (o !== null && n.parentId === noeuds.get(o)?.parentId) return 'voisin'
  if (chemin.has(id)) return 'ancetre'
  return 'cache'
}

/** Etat du globe `g` (id ou null) pour un id ouvert `o`. */
function etatGlobe(g, o) {
  if (g === o) return { echelle: 1, grille: GLOBES.ouvert.grille, verre: GLOBES.ouvert.verre, visible: true }
  // Le globe parent de la note ouverte reste en grille legere, sans verre.
  if (o !== null && g === noeuds.get(o)?.parentId) return { echelle: 1, grille: GLOBES.parent.grille, verre: GLOBES.parent.verre, visible: true }
  return { echelle: echelleDepart(g), grille: 0, verre: 0, visible: false }
}

/**
 * k <= 1 : fondu de l'ambre vers le fond (dimming par la couleur, opaque).
 * k > 1 : ambre boostee en lineaire (setHex a deja converti) → luit. Sans bloom
 * (telephone), ce gain ne ferait que saturer la teinte (ambre → jaune citron,
 * hors palette) : plafonne a 1, la bille garde l'ambre exact.
 */
const GAIN_MAX = bloomPossible ? Infinity : 1
function couleurBille(k, cible) {
  k = Math.min(k, GAIN_MAX)
  return k <= 1 ? cible.copy(AMBRE).lerp(FOND, 1 - k) : cible.copy(AMBRE).multiplyScalar(k)
}

/**
 * Seule la bille ouverte est au centre de son verre : dessinee apres lui
 * (renderOrder 3) et sans test de profondeur, sinon elle serait ternie a 45 %
 * et cesserait de luire.
 */
function drapeauxOuvert(bille, ouvert) {
  const materiau = bille.material
  if (materiau.transparent === ouvert) return
  materiau.transparent = ouvert
  materiau.depthTest = !ouvert
  bille.renderOrder = ouvert ? 3 : 0
}

/**
 * LA fonction qui ecrit les etats derives. Sans etat : chaque valeur est
 * calculee pour la configuration de depart et celle d'arrivee puis interpolee
 * par p ∈ [0, 1]. Au repos : appliquerEtat(id, id, 1). Idempotente.
 * `visible = false` n'est pose qu'a p = 1, sinon disparition seche en plein fondu.
 */
export function appliquerEtat(depuisId, versId, p) {
  const cheminA = new Set(cheminIdsDe(depuisId))
  const cheminB = new Set(cheminIdsDe(versId))
  const cliquables = []

  for (const n of noeuds.values()) {
    if (!n.ancre) continue
    const roleA = roleDe(n, depuisId, cheminA)
    const roleB = roleDe(n, versId, cheminB)
    const A = ROLES[roleA], B = ROLES[roleB]

    couleurBille(lerp(A.k, B.k, p), n.bille.material.color)
    let echelle = lerp(A.echelle, B.echelle, p)
    // Le survol est un etat transitoire hors modele ; on le preserve pour qu'un
    // appliquerEtat au repos (prechargement) ne fasse pas sauter la bille.
    if (n.note.id === survolId && roleB !== 'ouverte') echelle *= SURVOL.echelle
    n.bille.scale.setScalar(n.sBille * echelle)
    drapeauxOuvert(n.bille, roleA === 'ouverte' || roleB === 'ouverte')

    const halo = lerp(A.halo, B.halo, p)
    n.halo.material.opacity = halo
    n.halo.visible = halo > 0.01

    if (n.trait) {
      const trait = lerp(A.trait, B.trait, p)
      n.trait.material.opacity = trait
      n.trait.visible = trait > 0.01
    }

    // La classe d'arrivee est posee des p > 0 : c'est la CSS qui fait le fondu.
    const classe = p > 0 ? B.classe : A.classe
    const classes = n.etiquette.element.classList
    if (!classes.contains(classe)) {
      classes.remove(...CLASSES_TIER)
      classes.add(classe)
      n.taille = null // la taille de police depend du role
    }
    // Fin de transition : la police a fini de changer de taille, on remesure.
    if (p === 1 && depuisId !== versId) n.taille = null

    n.ancre.visible = p < 1 ? A.visible || B.visible : B.visible
    n.bille.visible = p < 1 ? A.bille !== false || B.bille !== false : B.bille !== false
    n.role = p < 1 ? (B.visible ? roleB : roleA) : roleB
    if (n.ancre.visible && n.bille.visible && n.role !== 'cache' && n.role !== 'ouverte') cliquables.push(n.bille)
  }
  billesCliquables = cliquables

  for (const [g, n] of noeuds) {
    if (!n.grille) continue
    const A = etatGlobe(g, depuisId), B = etatGlobe(g, versId)
    const echelle = lerp(A.echelle, B.echelle, p)
    n.grille.scale.setScalar(echelle)
    n.verre.scale.setScalar(echelle * GLOBES.retraitVerre)
    const opaciteGrille = lerp(A.grille, B.grille, p)
    const opaciteVerre = lerp(A.verre, B.verre, p)
    n.grille.material.opacity = opaciteGrille
    n.verre.material.opacity = opaciteVerre
    const visible = p < 1 ? A.visible || B.visible : B.visible
    n.grille.visible = visible && opaciteGrille > 0.01
    n.verre.visible = visible && opaciteVerre > 0.01
  }

  marquerSale()
}

// ---------------------------------------------------------------------------
// Survol, edition, retrait
// ---------------------------------------------------------------------------

let survolId = null

/**
 * Etat transitoire, hors appliquerEtat : bille ×1.3 (sauf ouverte), classe
 * `etiquette--survol`, et renderOrder 1 sur l'etiquette — le CSS2DRenderer trie
 * par renderOrder decroissant, elle passe donc au premier plan sans lutter
 * contre les zIndex qu'il ecrit. `null` = aucun survol.
 */
export function survoler(id) {
  if (id === survolId) return
  const ancien = noeuds.get(survolId)
  if (ancien?.ancre) {
    ancien.etiquette.element.classList.remove('etiquette--survol')
    ancien.etiquette.renderOrder = 0
    ancien.bille.scale.setScalar(ancien.sBille * ROLES[ancien.role].echelle)
  }
  survolId = id
  const n = noeuds.get(id)
  if (n?.ancre) {
    n.etiquette.element.classList.add('etiquette--survol')
    n.etiquette.renderOrder = 1
    if (n.role !== 'ouverte') n.bille.scale.setScalar(n.sBille * SURVOL.echelle)
  }
  marquerSale()
}

function preparerRaycast(sx, sy) {
  raycaster.setFromCamera(new THREE.Vector2((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1), camera)
}

const _bille = new THREE.Vector3()
const _echelleBille = new THREE.Vector3()

/**
 * Note cliquable sous le pointeur (billes des roles ≠ cache et ≠ ouverte). Sur
 * telephone une bille fait 6 a 10 px de diametre, un doigt la manque souvent :
 * si le rayon ne touche rien, on retient la fille ou petite-fille dont le bord
 * est le plus proche a l'ecran, a `tolerance` px pres. Freres et ancetres (grands
 * disques proches de la camera) ne sont retenus que touches directement.
 */
export function noteSousPointeur(sx, sy, tolerance = 0) {
  preparerRaycast(sx, sy)
  const touches = raycaster.intersectObjects(billesCliquables, false)
  if (touches.length > 0) return noeuds.get(touches[0].object.userData.id)?.note ?? null
  // px par unite monde a distance 1 (GEO_UNITE : rayon monde = echelle monde)
  const pxParUnite = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
  let meilleure = null, meilleurEcart = tolerance
  for (const bille of billesCliquables) {
    const n = noeuds.get(bille.userData.id)
    if (n.role !== 'enfant' && n.role !== 'petit') continue
    bille.getWorldPosition(_bille)
    const distance = _bille.distanceTo(camera.position)
    _bille.project(camera)
    if (_bille.z > 1) continue // derriere la camera
    const x = (_bille.x * 0.5 + 0.5) * innerWidth, y = (-_bille.y * 0.5 + 0.5) * innerHeight
    const rayonPx = (bille.getWorldScale(_echelleBille).x * pxParUnite) / distance
    const ecart = Math.hypot(x - sx, y - sy) - rayonPx
    if (ecart < meilleurEcart) {
      meilleurEcart = ecart
      meilleure = n.note
    }
  }
  return meilleure
}

/** Point monde vise sur la sphere qui porte les filles de `parentId` (null = racine). */
export function pointSurSphereDe(parentId, sx, sy) {
  const { centre, rayon } = sphereDe(parentId)
  preparerRaycast(sx, sy)
  const point = new THREE.Vector3()
  return raycaster.ray.intersectSphere(new THREE.Sphere(centre, rayon), point) ? point : null
}

/** Point monde sur une sphere -> (longitude, latitude) relatives a son centre. */
export function lonLatDepuisPoint(point, centre) {
  const p = point.clone().sub(centre).normalize()
  return {
    lon: THREE.MathUtils.radToDeg(Math.atan2(p.z, p.x)),
    lat: 90 - THREE.MathUtils.radToDeg(Math.acos(p.y)),
  }
}

/**
 * Deplace une note (glisser en mode edition). Ses filles suivent gratuitement
 * (hierarchie) ; seul le trait, qui vit dans le niveau du parent, est mis a jour
 * en place.
 */
export function deplacerNote(id, lon, lat) {
  const n = noeuds.get(id)
  if (!n?.ancre) return
  n.ancre.position.copy(positionNote(lon, lat))
  if (n.trait) {
    const positions = n.trait.geometry.attributes.position
    positions.setXYZ(1, n.ancre.position.x, n.ancre.position.y, n.ancre.position.z)
    positions.needsUpdate = true
  }
  marquerSale()
}

/** Met a jour la note et son etiquette apres un PUT, sans retirer/reposer. */
export function renommerNote(note) {
  const n = noeuds.get(note.id)
  if (!n?.ancre) return
  n.note = note
  n.etiquette.element.textContent = note.titre
  n.taille = null
  marquerSale()
}

/**
 * Retire une note et toute sa descendance. Dispose ce qui est propre au noeud
 * (materiaux, geometrie du trait) — jamais les geometries unite ni TEX_HALO,
 * partagees pour toute la vie de la page.
 */
export function retirerNote(id) {
  const n = noeuds.get(id)
  if (!n?.ancre) return
  for (const fille of enfantsDe(id)) retirerNote(fille.note.id)

  // Explicite : Object3D.remove(ancre) n'emet 'removed' que sur l'ancre, et
  // c'est cet evenement, sur le CSS2DObject, qui retire l'element du DOM.
  n.ancre.remove(n.etiquette)
  const parent = noeuds.get(n.parentId)
  parent?.niveau.remove(n.ancre)
  if (n.trait) parent?.niveau.remove(n.trait)

  n.bille.material.dispose()
  n.halo.material.dispose()
  n.trait?.geometry.dispose()
  n.trait?.material.dispose()
  n.grille?.material.dispose()
  n.verre?.material.dispose()

  // Un mesh retire resterait touchable par le raycast tant que le cache n'est
  // pas recalcule.
  billesCliquables = billesCliquables.filter((b) => b !== n.bille)
  if (survolId === id) survolId = null
  noeuds.delete(id)
  marquerSale()
}
