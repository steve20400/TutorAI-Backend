import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  detaillerLecon,
  listerLecons,
  normaliser,
  tableDesMatieres,
  trouverLecon,
} from "../src/tuteur/programme.js"

/**
 * Les deux programmes officiels, copiés ici comme jeu d'essai.
 *
 * Ils restent aussi dans `WEB/src/data/programmes/`, d'où ils servent à
 * remplir la table `programmes`. Ce sont deux usages différents du même
 * fichier : l'un alimente la base, l'autre éprouve le code qui la lit.
 */
const lire = (nom: string) =>
  JSON.parse(
    readFileSync(new URL(`./programmes/${nom}.json`, import.meta.url), "utf-8"),
  )

const CI = lire("ci-terminale-d-maths")
const CM = lire("cm-terminale-d-maths")

test("normaliser retire les accents et la ponctuation", () => {
  assert.equal(
    normaliser("Équations du Second Degré !"),
    "equations du second degre",
  )
  assert.equal(normaliser("  Limites   et  continuité  "), "limites et continuite")
})

test("listerLecons trouve les leçons sans confondre thèmes et compétences", () => {
  const lecons = listerLecons(CI)
  const titres = lecons.map((l) => l.titre)

  assert.ok(lecons.length >= 12, `attendu >= 12 leçons, obtenu ${lecons.length}`)
  assert.ok(titres.includes("Nombres complexes"))
  assert.ok(titres.includes("Primitives"))

  // Les compétences et les thèmes portent `intitule`, pas `titre` : ils ne
  // doivent jamais être remontés comme des leçons.
  assert.ok(
    !titres.some((t) => t.startsWith("Traiter une situation")),
    "une compétence a été prise pour une leçon",
  )
  assert.ok(!titres.includes("Fonctions"), "un thème a été pris pour une leçon")
})

test("trouverLecon reconnaît une leçon à partir des mots de l'élève", () => {
  const lecon = trouverLecon(CI, "aujourd'hui on a fait les limites et la continuité")
  assert.ok(lecon, "aucune leçon trouvée")
  assert.match(lecon.titre, /Limites et continuité/)
})

test("trouverLecon tolère les accents manquants", () => {
  const lecon = trouverLecon(CI, "on a vu les nombres complexes en cours")
  assert.ok(lecon)
  assert.equal(lecon.titre, "Nombres complexes")
})

test("trouverLecon refuse de deviner quand la correspondance est faible", () => {
  // « Équations du second degré » est une leçon de Première, pas de Terminale D.
  // Le tuteur doit demander une précision plutôt qu'inventer une leçon.
  assert.equal(trouverLecon(CI, "les équations du second degré"), null)
  assert.equal(trouverLecon(CI, "bonjour"), null)
  assert.equal(trouverLecon(CI, ""), null)
})

test("detaillerLecon expose les habiletés attendues du programme", () => {
  const lecon = trouverLecon(CI, "les nombres complexes")
  assert.ok(lecon)
  const detail = detaillerLecon(lecon)

  assert.match(detail, /Leçon L1\.1 — Nombres complexes/)
  assert.match(detail, /Habiletés et contenus attendus/)
  assert.match(detail, /équation du second degré à coefficients complexes/)
})

test("tableDesMatieres liste toutes les leçons", () => {
  const table = tableDesMatieres(CI)
  assert.match(table, /L1\.1 : Nombres complexes/)
  assert.match(table, /L2\.2 : Probabilité conditionnelle/)
})

test("le squelette camerounais ne fait pas passer un faux programme", () => {
  // Tant que le programme du MINESEC n'est pas saisi, aucune leçon réelle ne
  // doit être reconnue : le tuteur ne doit pas interroger sur du vide.
  assert.equal(trouverLecon(CM, "les nombres complexes"), null)
  assert.equal(trouverLecon(CM, "les limites et la continuité"), null)
})
