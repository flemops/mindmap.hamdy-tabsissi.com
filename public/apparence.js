// Reglages visuels de la scene, groupes par intention : c'est ICI qu'on ajuste
// ce qui se juge a l'oeil (« ancetres moins presents », « globe parent plus
// discret »...). La geometrie et la logique restent dans scene.js / controls.js.
// Taille et opacite des titres : style.css, bloc « Reglages des etiquettes ».
// Apres toute modification : `npm run verifier`, puis relire les captures.

// Palette stricte du portfolio, identique aux variables de style.css (sinon le
// fond HTML et le fond WebGL divergent). La scene reste sombre meme en theme clair.
export const COULEURS = { fond: 0x0f1115, ambre: 0xe6b450, texte: 0xece9e2, attenue: 0x9c9ba6 }

export const MONDE = {
  rayonGlobe: 100,
  /** Chaque niveau tient dans une sphere nettement plus petite que son parent. */
  facteurNiveau: 0.46,
  /** Rayon d'une bille en part du rayon de son globe, avec un minimum en unites monde (reste cliquable au plus profond). */
  tailleBille: 0.03,
  billeMin: 1.0,
  /** Halo de la note ouverte, en multiple du rayon de bille. */
  halo: 8,
  /** Hauteur du titre au-dessus de sa bille, en multiple du rayon de bille. */
  decalageEtiquette: 2.2,
}

// Gain lineaire des billes qui luisent : Y = 1.0 >= seuil .85 du bloom. 1.72 est
// le minimum theorique ; 2.0 garde une marge quand un filaire passe devant le
// coeur. Coeur trop blanc : baisser d'abord `force`, puis ce gain.
// force .55, rayon .4, seuil .85 : seules les billes a `coeur` (Y = 1.0) depassent
// le seuil ; grille, etoiles, traits et billes k <= 1 restent dessous.
// Le bloom coute ~x2,5 en images par seconde des que la camera bouge (mesure du
// 03/10/2026, Iris Xe) : coupe sur telephone (pointeur tactile et petit cote de
// l'ecran sous `petitCoteTelephone` px). `?sansbloom` le coupe partout,
// `?avecbloom` le force sur telephone (pour comparer).
export const LUEUR = { coeur: 2.0, force: 0.55, rayon: 0.4, seuil: 0.85, surTelephone: false, petitCoteTelephone: 600 }

// Globes (grille filaire + voile de verre). Ouvert : support lisible sans que ses
// courbes passent devant les titres. Parent : proche de la camera, il couvre
// l'ecran de grands arcs, d'ou une trace a peine visible (simple repere de profondeur).
export const GLOBES = {
  ouvert: { grille: 0.13, verre: 0.55 },
  parent: { grille: 0.022, verre: 0 },
  /** Verre legerement sous la grille : les fils restent nets devant le voile. */
  retraitVerre: 0.97,
}

// Apparence de chaque note selon son role par rapport a la note ouverte.
// k : couleur de la bille (<= 1 : de l'ambre vers le fond ; > 1 : luit) ;
// echelle : taille de bille ; halo, trait : opacites ; classe : niveau de titre (CSS) ;
// visible : l'ancre (et donc tout son sous-arbre) ; bille: false : bille masquee au repos.
export const ROLES = {
  ouverte: { k: LUEUR.coeur, echelle: 1.4, halo: 0.35, trait: 0.12, classe: 'etiquette--ouverte', visible: true },
  // Les enfants luisent aussi ; ceux qui passent derriere la face avant du verre sont
  // ternis a 45 % et cessent de luire, indice de profondeur voulu. Traits a .5 : la
  // relation mere → fille se lit sans rivaliser avec les titres.
  enfant: { k: LUEUR.coeur, echelle: 1, halo: 0, trait: 0.5, classe: 'etiquette--enfant', visible: true },
  petit: { k: 0.6, echelle: 1, halo: 0, trait: 0.2, classe: 'etiquette--petit', visible: true },
  // Freres : proches de la camera, ce sont de grands disques ; a k .3 ils formaient
  // des taches ocre plus visibles que la note ouverte. Cliquables, titre au survol.
  voisin: { k: 0.2, echelle: 1, halo: 0, trait: 0.1, classe: 'etiquette--cachee', visible: true },
  // Ancetres : bille au centre du globe parent, souvent juste derriere la camera,
  // d'ou un disque geant meme assombri. Eteinte puis masquee au repos ; l'ancre reste
  // visible car elle porte tout le sous-arbre. On y remonte par le fil d'Ariane,
  // « remonter » ou Echap.
  ancetre: { k: 0, echelle: 1, halo: 0, trait: 0, classe: 'etiquette--cachee', visible: true, bille: false },
  cache: { k: 0, echelle: 1, halo: 0, trait: 0, classe: 'etiquette--cachee', visible: false },
}

/** Bille survolee : grossie (sauf la note ouverte). */
export const SURVOL = { echelle: 1.3 }

// Collisions de titres : priorite d'affichage quand deux boites se recouvrent
// (a role egal, la face avant prime sur le dos du globe), en pixels.
export const ETIQUETTES = {
  priorite: { ouverte: 6, enfant: 4, petit: 2 },
  /** Px rognes de chaque cote : deux boites qui se frolent ne se genent pas. */
  margeBoite: 2,
  /** Px gardes entre un titre et le bord de la fenetre. */
  bordEcran: 6,
}

// Coquille lointaine : le fond bouge peu quand on orbite, effet « ciel » plutot que « confettis ».
export const ETOILES = { nombre: 1600, rayonMin: 1400, epaisseur: 1100, taille: 2.2, opacite: 0.8 }

// Decor spatial (ambiance.js) : couches d'etoiles, etoiles filantes, vaisseaux,
// satellites. Invariant : tout vit a `rayonMin` ou plus, au-dela de la distance
// maximale de la camera (controls.js#maxDistance ~ 800) : aucun element ne peut
// passer entre la camera et les notes, ni les masquer. Rien n'est cliquable.
// `opacite` : maximum de chaque famille ; le decor descend a `contexte.calme` de
// ces valeurs quand une note est ouverte ou la recherche active. Palette stricte :
// aucune couleur hors COULEURS, luminance sous le seuil du bloom (.85).
export const AMBIANCE = {
  rayonMin: 1000,
  /** Couches de la plus lointaine a la plus proche (profondeur par parallaxe de l'orbite). */
  couches: [
    { nombre: 900, rayon: [2300, 3300], taille: [0.8, 1.5], opacite: 0.55, scintillement: 0.15 },
    { nombre: 500, rayon: [1700, 2300], taille: [1.0, 2.0], opacite: 0.7, scintillement: 0.3 },
    { nombre: 160, rayon: [1150, 1500], taille: [1.6, 2.8], opacite: 0.85, scintillement: 0.45 },
  ],
  /** Part des etoiles teintees d'ambre (le reste : gris attenue). */
  partAmbre: 0.06,
  /** Scintillement : periode en secondes (propre a chaque etoile entre ces bornes). */
  periodeScintillement: [3, 9],
  filantes: {
    /** Delai aleatoire entre deux etoiles filantes (s) ; jamais deux en meme temps. */
    delai: [9, 22],
    duree: [0.8, 1.3],
    /** Distance de spawn devant la camera et longueur de trainee (unites monde). */
    profondeur: 1600,
    trainee: 260,
    vitesse: 820,
    opacite: 0.9,
    /** Zone d'apparition : part du demi-ecran minimum (0.6 = couronne exterieure, jamais le centre). */
    zoneMin: 0.6,
  },
  vaisseaux: {
    nombre: 3,
    rayon: [1150, 1350],
    /** Vitesse angulaire (rad/s) : un tour en 5 a 8 minutes. */
    vitesse: [0.013, 0.021],
    longueur: 15,
    opacite: 0.75,
    /** Variation lente de profondeur (part du rayon) et sa periode (s). */
    oscillation: 0.1,
    periodeOscillation: 70,
  },
  satellites: {
    nombre: 2,
    rayon: [1000, 1100],
    /** Un tour en 2,5 a 4 minutes. */
    vitesse: [0.026, 0.042],
    taille: 7,
    opacite: 0.8,
    /** Clignotement du feu de navigation (periode en s, part allumee). */
    clignotement: [2.4, 0.12],
  },
  contexte: {
    /** Facteur d'opacite quand une note est ouverte / la recherche active. */
    calme: 0.5,
    /** Duree de transition vers/depuis le calme (s). */
    transition: 0.6,
  },
  /** Cadence maximale des redessins dus au seul decor (la camera, elle, redessine a chaque image). */
  imagesParSeconde: 30,
  mobile: { facteurNombre: 0.4, vaisseaux: 1, satellites: 1, imagesParSeconde: 20 },
}

export const CAMERA = {
  fov: 50,
  // fitToSphere n'a aucun padding : Sphere(centre, r × 1.3) donne ≈ 3.08 r de
  // distance (fov 50, paysage), proche du cadrage historique.
  margeCadrage: 1.3,
  /** Distance minimale en rayons du globe vise : sous 1, un dollyTo collerait la camera dans le verre. */
  distanceMin: 1.15,
  /** Amorti (s) : au repos, pendant un vol multi-niveaux, pendant un glisser. */
  amorti: 0.35,
  amortiVol: 0.2,
  amortiGlisser: 0.12,
}
