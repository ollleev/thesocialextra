# Sécurité

Ce logiciel est en validation. Ne pas l’ouvrir au public avec des pages légales incomplètes, sans modération humaine ou sans sauvegardes vérifiées. Les plafonds implémentés ne constituent pas une preuve de résistance à la charge ou aux attaques distribuées.

Pour une vulnérabilité, utiliser le signalement privé de GitHub lorsqu’il est disponible dans l’onglet Security. Ne pas publier une exploitation active, des secrets, une base ou des conversations privées dans une issue publique. Décrire le comportement avec des comptes et messages synthétiques, la version concernée et des étapes minimales.

## Principes vérifiés dans les tests

- Autorisations côté serveur, cookies HttpOnly et requêtes mutantes limitées à l’origine configurée.
- Requêtes SQLite paramétrées et transactions ; aucune session ou phrase secrète stockée en clair.
- Isolation des discussions, révocation, blocage et suppression ; reprises idempotentes bornées sans duplication silencieuse.
- Quotas de comptes, messages et preuves ; aucune éviction anticipée d’une intention valide pour libérer de la place.
- Sauvegardes authentifiées et restauration testée ; aucun cache de contenu privé dans le service worker.
- Journal d’effacement indépendant lorsqu’il est initialisé et configuré ; incident de réconciliation ferme les API, rejeu avant écoute au redémarrage. Une ancienne copie cohérente ne prouve pas l’exhaustivité après perte du serveur : voir [ERASURE.md](ERASURE.md).
- Événements privés autorisés par propriétaire et révision ; publication séparée après aperçu, sans copie du titre, lieu exact ou consignes privées. Ce n’est pas une réservation de personnel.

Les messages ne sont pas chiffrés de bout en bout. L’opérateur technique peut accéder au stockage. Les personnes, compétences et autorisations de travail ne sont pas vérifiées. Un audit indépendant et des tests de charge supplémentaires restent nécessaires avant un lancement large.
