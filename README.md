# exam-civic-2026

Examens blancs aléatoires de 40 questions pour s'entraîner à l'examen civique.

**Site : https://hopefreeproject.github.io/exam-civic-2026/**

- 40 questions tirées au hasard selon la répartition par thème, 45 minutes, réussite à 32/40.
- QCM : jusqu'à 4 propositions, une ou plusieurs bonnes réponses. 1 point seulement si toutes les bonnes réponses (et uniquement elles) sont cochées, sans point négatif.
- À la fin : le score, le détail par thème et la revue de chaque question, avec l'extrait des fiches PDF qui explique la réponse.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Affichage (responsive, mobile) |
| `quiz.js` | Logique du quiz |
| `questions.js` | Questions, réponses et extraits des PDF (JSON précédé de `window.EXAM_DATA =`) |
| `*.pdf` | Fiches de révision sources |

## Utilisation locale

Ouvrez `index.html` dans un navigateur, sans serveur. En local, la correction ouvre le PDF à la bonne page. Sur GitHub Pages, elle affiche en plus la page du PDF avec le passage surligné.

Outil d'entraînement non officiel : vérifiez les informations officielles avant l'examen.
