# Journal d’effacement et restauration

Ces outils sont à installer et vérifier par l’opérateur. Leur présence dans le dépôt ne prouve pas qu’une instance les utilise. Ne pas annoncer un effacement irréversible après restauration sans une référence indépendante suffisamment actuelle.

## Fonctionnement et limites

Après validation de la demande d’effacement, une intention est engagée dans un SQLite séparé avant l’effacement de la base applicative. Elle contient l’identifiant technique du compte, une séquence, une date et une chaîne d’empreintes ; pas de pseudonyme, message ou média. Ces identifiants restent des données à protéger : jamais dans Git, une issue ou un journal public.

L’effacement et l’avancement du checkpoint applicatif sont transactionnels. Si l’intention ou sa réconciliation échoue, y compris avec une réponse incertaine, le serveur suspend API et flux. Le démarrage rejoue les intentions restantes avant d’écouter. Journal absent, incompatible, tronqué sous le checkpoint ou incohérent : démarrage refusé. La chaîne SHA détecte des incohérences, pas une omission volontaire ni la perte simultanée de copies plus récentes. Aucun test de coupure électrique physique ni RPO nul n’est revendiqué.

Le journal est plafonné à16Mio et100000intentions, sans purge automatique. Sa conservation doit couvrir les copies restaurables qui pourraient encore contenir les comptes supprimés. Ne pas remettre la séquence à zéro pour libérer de la place.

## Initialiser avant les premières inscriptions

Un seul processus applicatif est pris en charge. L’initialisation exige une base applicative existante et privée, sans aucun compte. Arrêter le service et conserver un snapshot cohérent ainsi que la configuration précédente. Préparer un dossier0700 et un nouveau chemin de journal, détenus par le compte applicatif. Le fichier sera privé0600. Ne pas utiliser de lien symbolique ni remplacer un journal existant.

Depuis le répertoire physique de la release (résoudre les liens de déploiement), sous le compte propriétaire de la base :

```sh
node ops/erasure-recovery.mjs init /etat/app.sqlite /etat/erasure/journal.sqlite
```

Les chemins sont des exemples à remplacer, pas des chemins à créer automatiquement. Conserver le résultat de l’initialisation dans un emplacement privé distinct ; il fournit le point initial de confiance. Configurer ensuite `ERASURE_JOURNAL_PATH` avec le chemin absolu du journal avant de redémarrer. Contrôler le checkpoint et réaliser un parcours synthétique complet. Une initialisation partielle doit être inspectée, jamais supprimée/recréée automatiquement.

Une base déjà associée au journal ne peut plus démarrer sans sa configuration. Ne pas revenir à une ancienne release ignorant les checkpoints. Les sauvegardes antérieures à l’association et les bases déjà peuplées ne sont pas migrées automatiquement par ces outils : préparer une procédure distincte, sans effacer de comptes pour passer le contrôle.

## Copier le journal séparément

`ops/erasure-backup.mjs JOURNAL DOSSIER_DESTINATION CLE_AES` produit et vérifie une copie chiffrée avec une clé opérateur existante. Dossier privé dédié, distinct des sauvegardes applicatives ; clé0600 hors du code et hors de l’application. Les modèles `deploy/thesocialextra-erasure-backup.service` et `.timer` proposent un passage toutes les cinq minutes avec décalage maximal20secondes. Ils n’installent rien et ne prouvent ni le déclenchement ni une copie hors serveur. Le service utilise une capacité de lecture root : revoir son confinement, ses chemins et permissions avant activation.

Le producteur conserve deux points engagés et vérifiés, dans un budget de128Mio. Il ne sacrifie pas les fichiers inconnus pour faire de la place. Un verrou ou staging abandonné doit être inspecté après vérification qu’aucun job n’est actif ; pas de purge générale.

Sur une machine indépendante, `ops/erasure-pull-job.mjs CONFIG STATUS PIN` réutilise le transport de sauvegardes avec **un dossier, une configuration et une autorisation SSH de lecture dédiés au journal**. Ne pas mélanger les archives du journal et celles de l’application. Le modèle de commande SSH forcée décrit dans [BACKUP.md](BACKUP.md#clé-de-transfert-dédiée-et-commande-forcée) peut être réutilisé avec une autre clé limitée au seul dossier du journal.

La configuration contient les mêmes cinq champs que celle de `backup-pull.mjs` : `host`, `identityFile`, `remoteDirectory`, `localDirectory`, `keyFile`. Configuration, statut et pin restent privés, hors du code ; le parent du pin est0700, son fichier0600, détenu par le compte exécutant. Le pin initial se crée explicitement avec l’API `initializeErasurePin(pinFile, tip)` exportée par `ops/erasure-pull-job.mjs`, à partir du point de séquence0 attesté lors de l’initialisation. Il ne se déduit pas d’une vieille archive au moment de restaurer. Aucun initialiseur automatique ou récupération de confiance perdue n’est fourni.

Le transfert refuse un changement de journal, un recul de séquence, un préfixe différent ou une date de snapshot régressive. Il revérifie cryptographiquement les points retenus avant rotation ; seuls les fichiers suivis par le pin et reconnus peuvent être retirés. Deux points sont conservés, avec budget local64Mio. Les fichiers inconnus restent à inspecter.

`node ops/erasure-pull-job.mjs --check STATUS PIN` vérifie l’attestation et sa fraîcheur, pas une nouvelle lecture ou un nouveau déchiffrement de l’archive. Il refuse un point de plus de deux heures et applique également les contrôles de statut du transport. Ce seuil n’est pas un SLA. Planification, réseau, garde des clés, supervision indépendante et destinataire d’alerte doivent être organisés et testés séparément.

## Préparer une restauration

1. Garder l’accès public fermé. Déchiffrer la sauvegarde applicative dans un dossier privé distinct ; ne pas remplacer la base active ni ses fichiers WAL/SHM.
2. Obtenir le journal et un point actuel par une source indépendante maîtrisée. Le point a exactement les champs `epoch`, `journalId`, `seq`, `hash`. Un ancien couple base/journal cohérent ou un pin ancien ne suffit pas après perte du primaire : résoudre la période éventuellement non couverte avant réouverture.
3. Lancer `node ops/erasure-recovery.mjs prepare SOURCE JOURNAL NOUVELLE_DESTINATION JSON_DU_POINT_INDEPENDANT`, avec chemins absolus distincts et JSON comme un seul argument. Ne pas mettre ces données opérationnelles dans les tickets, dépôts ou logs publics. L’outil vérifie le point avant copie, rejoue les effacements dans la nouvelle destination, puis contrôle intégrité et clés étrangères. Il ne modifie pas la source et retourne toujours `publicationAuthorized:false`.
4. Examiner résultat, permissions, suppressions connues et accès. Un échec peut laisser une sortie privée partielle pour inspection ; elle n’est pas publiable. Ne pas promouvoir automatiquement la copie et ne pas effacer le retour arrière.

`inspect JOURNAL` fournit le point vérifié d’un journal ; le lire dans une vieille archive n’en fait pas une référence actuelle. Une erreur de réconciliation du serveur émet seulement `erasure_reconciliation_required` avant fermeture des API. Corriger la cause et redémarrer pour le rejeu ; ne jamais supprimer le checkpoint ou neutraliser le garde pour remettre le service en ligne.

Les tests automatiques couvrent copie, corruption, refus de régression, effacement et restauration sur données synthétiques. Ils ne prouvent pas la fraîcheur d’une instance, la réception des alertes par une personne ni l’exhaustivité après perte totale de son serveur.
