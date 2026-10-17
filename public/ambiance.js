// Decor spatial : couches d'etoiles (profondeur et scintillement), etoiles
// filantes, petits vaisseaux, satellites. Module isole : il ne connait que la
// scene et la camera, jamais les notes, l'API ni le HUD. scene.js le cree, app.js
// lui donne le temps ecoule et le contexte (note ouverte / recherche active).
//
// Garanties (28.8, 28.16, 28.18, 28.21) :
// - tout vit a AMBIANCE.rayonMin ou plus, au-dela de la distance maximale de la
//   camera : rien ne passe entre la camera et les notes ;
// - aucun element n'est dans le raycast (scene.js ne teste que `billesCliquables`) ;
// - mouvement coupe si `prefers-reduced-motion` (aussi en cours de session) ou si
//   le visiteur l'a coupe (bouton du HUD, memorise) ; le decor reste, fige ;
// - redessin du seul decor plafonne (imagesParSeconde) : le rendu a la demande de
//   scene.js n'est pas annule, il est borne ;
// - maj() ne fait rien d'autre qu'avancer un temps : onglet masque = rAF suspendu
//   par le navigateur, dt est borne a 0,1 s au retour.
import * as THREE from './vendor/three-0.185.1/build/three.module.min.js'
import { COULEURS, AMBIANCE } from './apparence.js'

const CLE_PREF = 'mindmap-decor-anime'
const ATTENUE = new THREE.Color(COULEURS.attenue)
const AMBRE = new THREE.Color(COULEURS.ambre)
const TEXTE = new THREE.Color(COULEURS.texte)
const FOND = new THREE.Color(COULEURS.fond)

const alea = (a, b) => a + Math.random() * (b - a)
const dans = ([a, b]) => alea(a, b)
const pixelRatio = () => Math.min(devicePixelRatio, 2)

function lirePref() {
  try {
    return localStorage.getItem(CLE_PREF)
  } catch {
    return null
  }
}
function ecrirePref(valeur) {
  try {
    localStorage.setItem(CLE_PREF, valeur)
  } catch {
    // Navigation privee ou stockage refuse : la preference vaut pour la session.
  }
}

/** Deux vecteurs unitaires orthogonaux au hasard : un plan d'orbite par le centre. */
function planAleatoire() {
  const u = new THREE.Vector3(alea(-1, 1), alea(-1, 1), alea(-1, 1)).normalize()
  const w = new THREE.Vector3(alea(-1, 1), alea(-1, 1), alea(-1, 1)).cross(u).normalize()
  return { u, w }
}

const VERTEX_ETOILES = /* glsl */ `
  attribute float phase;
  attribute float omega;
  attribute float taille;
  attribute vec3 couleur;
  uniform float uT;
  uniform float uScint;
  uniform float uPx;
  varying vec3 vC;
  varying float vA;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = taille * uPx;
    vA = 1.0 - uScint * (0.5 + 0.5 * sin(uT * omega + phase));
    vC = couleur;
  }
`
const FRAGMENT_ETOILES = /* glsl */ `
  uniform float uOpacite;
  varying vec3 vC;
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vC, uOpacite * vA * smoothstep(0.5, 0.12, d));
    #include <colorspace_fragment>
  }
`

/**
 * @param {THREE.Scene} scene
 * @param {THREE.PerspectiveCamera} camera
 * @param {{ telephone: boolean }} options
 */
export function creerAmbiance(scene, camera, { telephone }) {
  const cfg = AMBIANCE
  const facteurNombre = telephone ? cfg.mobile.facteurNombre : 1
  const pas = 1 / (telephone ? cfg.mobile.imagesParSeconde : cfg.imagesParSeconde)
  const mouvementSysteme = matchMedia('(prefers-reduced-motion: reduce)')
  const coupeParUrl = location.search.includes('sansdecor')
  let prefVisiteur = lirePref() // 'non' = mouvement coupe par le visiteur

  const racine = new THREE.Group()
  racine.visible = !coupeParUrl
  scene.add(racine)
  const disposables = []

  let temps = 0
  let cumul = 0
  let facteurContexte = 1
  let sale = true // un redessin est du meme si rien n'anime (bascule, contexte, resize)
  let filantesLancees = 0

  const mouvement = () => !coupeParUrl && !mouvementSysteme.matches && prefVisiteur !== 'non'
  const onChangement = () => {
    sale = true
  }
  mouvementSysteme.addEventListener('change', onChangement)

  // --- Couches d'etoiles -----------------------------------------------------

  const couches = cfg.couches.map((c) => {
    const n = Math.max(1, Math.round(c.nombre * facteurNombre))
    const positions = new Float32Array(n * 3)
    const couleurs = new Float32Array(n * 3)
    const phases = new Float32Array(n)
    const omegas = new Float32Array(n)
    const tailles = new Float32Array(n)
    const teinte = new THREE.Color()
    for (let i = 0; i < n; i++) {
      const rayon = dans(c.rayon)
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      positions[i * 3] = rayon * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = rayon * Math.cos(phi)
      positions[i * 3 + 2] = rayon * Math.sin(phi) * Math.sin(theta)
      teinte.copy(Math.random() < cfg.partAmbre ? AMBRE : ATTENUE).lerp(TEXTE, Math.random() * 0.25)
      couleurs.set([teinte.r, teinte.g, teinte.b], i * 3)
      phases[i] = Math.random() * Math.PI * 2
      omegas[i] = (Math.PI * 2) / dans(cfg.periodeScintillement)
      tailles[i] = dans(c.taille)
    }
    const geometrie = new THREE.BufferGeometry()
    geometrie.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometrie.setAttribute('couleur', new THREE.BufferAttribute(couleurs, 3))
    geometrie.setAttribute('phase', new THREE.BufferAttribute(phases, 1))
    geometrie.setAttribute('omega', new THREE.BufferAttribute(omegas, 1))
    geometrie.setAttribute('taille', new THREE.BufferAttribute(tailles, 1))
    const materiau = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uScint: { value: 0 }, uPx: { value: pixelRatio() }, uOpacite: { value: c.opacite } },
      vertexShader: VERTEX_ETOILES,
      fragmentShader: FRAGMENT_ETOILES,
      transparent: true,
      depthWrite: false,
    })
    const points = new THREE.Points(geometrie, materiau)
    points.frustumCulled = false // rayon >> boite englobante utile, cout nul
    points.renderOrder = -20
    racine.add(points)
    disposables.push(geometrie, materiau)
    return { cfg: c, materiau, n }
  })

  // --- Etoile filante (une seule a la fois) ----------------------------------

  const POINTS_TRAINEE = 14
  const trainee = {
    actif: false,
    t: 0,
    duree: 1,
    tete: new THREE.Vector3(),
    dir: new THREE.Vector3(),
  }
  const geoTrainee = new THREE.BufferGeometry()
  const posTrainee = new Float32Array(POINTS_TRAINEE * 3)
  const colTrainee = new Float32Array(POINTS_TRAINEE * 3)
  {
    // Tete claire -> queue qui se fond dans le fond : « progressive » sans alpha par sommet.
    const c = new THREE.Color()
    for (let i = 0; i < POINTS_TRAINEE; i++) {
      c.copy(FOND).lerp(TEXTE, 0.9 * (1 - i / (POINTS_TRAINEE - 1)) ** 1.6)
      colTrainee.set([c.r, c.g, c.b], i * 3)
    }
  }
  geoTrainee.setAttribute('position', new THREE.BufferAttribute(posTrainee, 3))
  geoTrainee.setAttribute('color', new THREE.BufferAttribute(colTrainee, 3))
  const matTrainee = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false })
  const ligneTrainee = new THREE.Line(geoTrainee, matTrainee)
  ligneTrainee.frustumCulled = false
  ligneTrainee.visible = false
  ligneTrainee.renderOrder = -19
  racine.add(ligneTrainee)
  disposables.push(geoTrainee, matTrainee)
  let delaiFilante = dans(cfg.filantes.delai)

  /** Part de l'ecran visee en espace camera : couronne exterieure, jamais le centre (28.10). */
  function lancerFilante() {
    const f = cfg.filantes
    camera.updateMatrixWorld()
    const e = camera.matrixWorld.elements
    const droite = new THREE.Vector3(e[0], e[1], e[2])
    const haut = new THREE.Vector3(e[4], e[5], e[6])
    const arriere = new THREE.Vector3(e[8], e[9], e[10])
    const demiH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * f.profondeur
    const demiL = demiH * camera.aspect
    let nx, ny
    do {
      nx = alea(-1, 1)
      ny = alea(-1, 1)
    } while (Math.max(Math.abs(nx), Math.abs(ny)) < f.zoneMin)
    // Direction perpendiculaire au rayon centre -> point (reste dans la couronne), un peu vers l'exterieur.
    const sens = Math.random() < 0.5 ? -1 : 1
    let dx = -ny * sens + nx * 0.25
    let dy = nx * sens + ny * 0.25
    const norme = Math.hypot(dx, dy)
    dx /= norme
    dy /= norme
    trainee.tete
      .copy(camera.position)
      .addScaledVector(droite, nx * demiL)
      .addScaledVector(haut, ny * demiH)
      .addScaledVector(arriere, -f.profondeur)
    trainee.dir.set(0, 0, 0).addScaledVector(droite, dx).addScaledVector(haut, dy).normalize()
    trainee.t = 0
    trainee.duree = dans(f.duree)
    trainee.actif = true
    ligneTrainee.visible = true
    filantesLancees++
  }

  function avancerFilante(dt, calme) {
    const f = cfg.filantes
    if (!trainee.actif) {
      if (calme) return
      delaiFilante -= dt
      if (delaiFilante <= 0) {
        lancerFilante()
        delaiFilante = dans(f.delai)
      }
      return
    }
    trainee.t += dt
    const p = trainee.t / trainee.duree
    if (p >= 1) {
      trainee.actif = false
      ligneTrainee.visible = false
      return
    }
    trainee.tete.addScaledVector(trainee.dir, f.vitesse * dt)
    // Enveloppe douce : apparition et extinction sans a-coup, pas de flash.
    matTrainee.opacity = f.opacite * Math.sin(Math.PI * p) * facteurContexte
    const longueur = f.trainee * Math.min(1, p / 0.15 + 0.2)
    for (let i = 0; i < POINTS_TRAINEE; i++) {
      const d = (longueur * i) / (POINTS_TRAINEE - 1)
      posTrainee[i * 3] = trainee.tete.x - trainee.dir.x * d
      posTrainee[i * 3 + 1] = trainee.tete.y - trainee.dir.y * d
      posTrainee[i * 3 + 2] = trainee.tete.z - trainee.dir.z * d
    }
    geoTrainee.attributes.position.needsUpdate = true
  }

  // --- Vaisseaux et satellites -----------------------------------------------

  const matVaisseau = new THREE.MeshBasicMaterial({ color: ATTENUE, transparent: true, opacity: cfg.vaisseaux.opacite })
  const matSatellite = new THREE.MeshBasicMaterial({ color: ATTENUE, transparent: true, opacity: cfg.satellites.opacite })
  const geoCorps = new THREE.ConeGeometry(0.9, 4, 5).rotateX(Math.PI / 2) // pointe vers +Z (lookAt)
  const geoAile = new THREE.BoxGeometry(5, 0.18, 1.4)
  const geoDeriv = new THREE.BoxGeometry(0.15, 1.2, 1)
  const geoSat = new THREE.BoxGeometry(1, 0.6, 0.6)
  const geoPanneau = new THREE.BoxGeometry(1.2, 0.05, 0.7)
  const geoFeu = new THREE.BufferGeometry()
  geoFeu.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
  const matFeuVaisseau = new THREE.PointsMaterial({ color: AMBRE, size: 2.2 * pixelRatio(), sizeAttenuation: false, transparent: true, depthWrite: false })
  const matFeuSatellite = matFeuVaisseau.clone()
  disposables.push(matVaisseau, matSatellite, geoCorps, geoAile, geoDeriv, geoSat, geoPanneau, geoFeu, matFeuVaisseau, matFeuSatellite)

  const nVaisseaux = telephone ? cfg.mobile.vaisseaux : cfg.vaisseaux.nombre
  const nSatellites = telephone ? cfg.mobile.satellites : cfg.satellites.nombre

  function feu(materiau, x, y, z) {
    const p = new THREE.Points(geoFeu, materiau)
    p.position.set(x, y, z)
    p.frustumCulled = false
    return p
  }

  const vaisseaux = Array.from({ length: nVaisseaux }, () => {
    const v = cfg.vaisseaux
    const g = new THREE.Group()
    const corps = new THREE.Mesh(geoCorps, matVaisseau)
    const aile = new THREE.Mesh(geoAile, matVaisseau)
    aile.position.z = -0.8
    const deriv = new THREE.Mesh(geoDeriv, matVaisseau)
    deriv.position.set(0, 0.6, -1.2)
    g.add(corps, aile, deriv, feu(matFeuVaisseau, 2.5, 0, -0.8))
    g.scale.setScalar(v.longueur / 4)
    g.renderOrder = -10
    g.traverse((o) => (o.renderOrder = -10))
    racine.add(g)
    const { u, w } = planAleatoire()
    return {
      g, u, w,
      r0: dans(v.rayon),
      omega: dans(v.vitesse) * (Math.random() < 0.5 ? -1 : 1),
      theta0: Math.random() * Math.PI * 2,
      phi: Math.random() * Math.PI * 2,
      decal: Math.random() * 10,
    }
  })

  const satellites = Array.from({ length: nSatellites }, () => {
    const s = cfg.satellites
    const g = new THREE.Group()
    g.add(new THREE.Mesh(geoSat, matSatellite))
    for (const cote of [-1, 1]) {
      const p = new THREE.Mesh(geoPanneau, matSatellite)
      p.position.x = cote * 1.1
      g.add(p)
    }
    g.add(feu(matFeuSatellite, 0, 0.4, 0))
    g.scale.setScalar(s.taille)
    g.traverse((o) => (o.renderOrder = -10))
    racine.add(g)
    const { u, w } = planAleatoire()
    return {
      g, u, w,
      r: dans(s.rayon),
      omega: dans(s.vitesse) * (Math.random() < 0.5 ? -1 : 1),
      theta0: Math.random() * Math.PI * 2,
      decal: Math.random() * 10,
    }
  })

  const tmp = new THREE.Vector3()
  function placer() {
    const v = cfg.vaisseaux
    for (const o of vaisseaux) {
      const theta = o.theta0 + o.omega * temps
      const r = o.r0 * (1 + v.oscillation * Math.sin((Math.PI * 2 * temps) / v.periodeOscillation + o.phi))
      o.g.position.copy(o.u).multiplyScalar(Math.cos(theta) * r).addScaledVector(o.w, Math.sin(theta) * r)
      const suivant = theta + Math.sign(o.omega) * 0.02
      tmp.copy(o.u).multiplyScalar(Math.cos(suivant) * r).addScaledVector(o.w, Math.sin(suivant) * r)
      o.g.lookAt(tmp)
    }
    for (const o of satellites) {
      const theta = o.theta0 + o.omega * temps
      o.g.position.copy(o.u).multiplyScalar(Math.cos(theta) * o.r).addScaledVector(o.w, Math.sin(theta) * o.r)
      o.g.rotation.y = theta * 3
    }
  }

  function clignoter(materiau, base, decal) {
    const [periode, part] = cfg.satellites.clignotement
    const phase = ((temps + decal) % periode) / periode
    materiau.opacity = (phase < part ? 1 : 0.15) * base
  }

  function appliquerOpacites() {
    const f = facteurContexte
    for (const c of couches) c.materiau.uniforms.uOpacite.value = c.cfg.opacite * f
    matVaisseau.opacity = cfg.vaisseaux.opacite * f
    matSatellite.opacity = cfg.satellites.opacite * f
    // Feux : un seul materiau par famille, le clignotement de reference vient du premier objet.
    matFeuVaisseau.opacity = 0.9 * f
    clignoter(matFeuSatellite, f, satellites[0]?.decal ?? 0)
    if (!mouvement()) matFeuSatellite.opacity = 0.9 * f
  }

  placer()
  appliquerOpacites()

  // --- Boucle ----------------------------------------------------------------

  /**
   * Avance le decor. Retourne true si la scene doit etre redessinee a cause de lui.
   * @param {number} dt secondes depuis l'image precedente
   * @param {{ calme: boolean }} contexte note ouverte / recherche active
   */
  function maj(dt, contexte) {
    if (coupeParUrl) return false
    const anime = mouvement()
    dt = Math.min(Math.max(dt, 0), 0.1)

    const cible = contexte.calme ? cfg.contexte.calme : 1
    const ecart = cible - facteurContexte
    let redessiner = sale
    if (Math.abs(ecart) > 0.002) {
      facteurContexte += Math.sign(ecart) * Math.min(Math.abs(ecart), (dt / cfg.contexte.transition) * (1 - cfg.contexte.calme))
      redessiner = true
    }

    if (anime) {
      temps += dt
      cumul += dt
      avancerFilante(dt, contexte.calme)
    } else if (trainee.actif) {
      trainee.actif = false
      ligneTrainee.visible = false
      redessiner = true
    }

    if (redessiner || (anime && cumul >= pas)) {
      cumul = 0
      sale = false
      for (const c of couches) {
        c.materiau.uniforms.uT.value = temps
        c.materiau.uniforms.uScint.value = anime ? c.cfg.scintillement : 0
      }
      placer()
      appliquerOpacites()
      return true
    }
    return trainee.actif && anime // la trainee avance a chaque image tant qu'elle est visible
  }

  // --- Interface -------------------------------------------------------------

  return {
    maj,
    /** Bouton du HUD : coupe / rallume le mouvement (memorise). Retourne l'etat apres bascule. */
    basculerMouvement() {
      prefVisiteur = prefVisiteur === 'non' ? 'oui' : 'non'
      ecrirePref(prefVisiteur)
      sale = true
      return mouvement()
    },
    mouvementActif: mouvement,
    /** Le systeme impose le mouvement reduit : le bouton ne peut pas le lever. */
    imposeParLeSysteme: () => mouvementSysteme.matches,
    /** Taille des feux en pixels ecran, a rappeler au changement de ratio. */
    redimensionner() {
      const px = pixelRatio()
      matFeuVaisseau.size = matFeuSatellite.size = 2.2 * px
      for (const c of couches) c.materiau.uniforms.uPx.value = px
      sale = true
    },
    /** Pour les tests et le verificateur : jamais utilise par l'appli. */
    forcerFilante: lancerFilante,
    etat: () => ({
      coupeParUrl,
      mouvement: mouvement(),
      reduitSysteme: mouvementSysteme.matches,
      etoiles: couches.reduce((s, c) => s + c.n, 0),
      couches: couches.length,
      vaisseaux: vaisseaux.length,
      satellites: satellites.length,
      objets: racine.children.length,
      filanteActive: trainee.actif,
      filantesLancees,
      facteurContexte,
      rayonMinObserve: Math.min(
        ...[...vaisseaux, ...satellites].map((o) => o.g.position.length()),
        ...couches.map((c) => c.cfg.rayon[0])
      ),
    }),
    dispose() {
      mouvementSysteme.removeEventListener('change', onChangement)
      scene.remove(racine)
      for (const d of disposables) d.dispose()
    },
  }
}
