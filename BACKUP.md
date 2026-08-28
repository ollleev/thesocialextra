# Sauvegardes et restauration

Ce modèle doit être adapté et vérifié par l’opérateur de chaque instance. Il ne garantit ni disponibilité, ni copie hors serveur, ni conformité juridique.

## Job proposé

`ops/backup-job.mjs` lit une clé existante, prend un instantané SQLite en ligne, chiffre en AES256GCM, déchiffre vers un fichier distinct et contrôle son intégrité. Il ne publie le fichier `.tseb` qu’après cette vérification. La clé n’est ni générée automatiquement par ce job, ni affichée dans ses sorties.

Le volume est mesuré dans une transaction de lecture SQLite, journal WAL compris. La copie utilise ce même instantané : une écriture concurrente n’augmente pas la copie après son contrôle de capacité. Les destinations sont créées exclusivement en0600 avant d’écrire du texte clair. [Mécanisme de sauvegarde SQLite](https://www.sqlite.org/backup.html).

Politique du modèle : un passage quotidien à03:30UTC, décalé aléatoirement d’au plus10minutes ; rattrapage après indisponibilité. Conservation de7jours, budget de4Gio pour les points retenus, réserve disque de1Gio en plus du travail estimé. Les limites sont des choix de pilote à reconsidérer selon la croissance ; elles ne garantissent pas l’espace disponible si d’autres services remplissent simultanément le même disque.

Le job refuse un nouveau point si son budget serait dépassé. Il ne supprime pas les points encore dans leur durée pour faire de la place. La rotation ne touche que les fichiers réguliers correspondant au format exact de ses snapshots, après succès d’un nouveau point. Les fichiers étrangers et liens symboliques restent intacts.

## Compte et confinement du modèle

Le modèle systemd exécute le job avec root et seulement la capacité `CAP_DAC_READ_SEARCH`, nécessaire pour lire la base privée appartenant au service. Le code de release doit donc rester non modifiable par le compte applicatif. Le réseau IP est isolé, les écritures sont limitées au dossier de sauvegarde, les répertoires personnels et la configuration de l’application sont masqués. Mémoire256Mio, fichier2Gio, délai120secondes. Le service dépend de l’application et attend au maximum15secondes que ses fichiers WAL/SHM soient présents. Après arrêt propre du dernier écrivain, une base au format WAL peut refuser une ouverture sur un montage en lecture seule ; ne pas utiliser immutable sur la base vivante pour contourner ce refus. Si le serveur s’arrête pendant la copie, conserver les anciens points et vérifier le résultat du job.

Ce n’est **pas** un confinement strict en lecture : cette capacité permet de lire d’autres chemins non masqués. Ne pas annoncer le contraire. Le déploiement doit vérifier les propriétés effectivement appliquées et ne pas élargir les permissions de la base pour faire fonctionner la copie. Ne pas exposer ce job par une route web.

## Avant activation

1. Créer un dossier de sauvegarde dédié0700 et un dossier de clé privé ; installer une clé256bits0600, conservée séparément dans un second emplacement maîtrisé. Ne jamais mettre la clé ou les archives dans Git, même privé.
2. Copier les unités de ce dépôt après revue ; ne toucher à aucun service d’un autre produit.
3. Lancer un passage réel sur la base dédiée, inspecter le résultat, le chiffrement, les permissions et l’absence de staging en clair après succès.
4. Copier un point chiffré hors serveur, le déchiffrer vers un nouveau chemin privé et vérifier l’intégrité ainsi que les contrôles métier. Une vérification sur base vide ne prouve pas la restauration de comptes et messages ; les essais non vides restent synthétiques.
5. Activer le timer uniquement après ces contrôles, puis vérifier son prochain passage et le résultat du service.

## En cas d’échec

Le journal du job ne doit contenir que le nom du point, sa taille, le résultat d’intégrité et le nombre d’anciens points retirés. Un résultat non nul ne signifie pas qu’une sauvegarde utilisable a été créée. Inspecter l’espace disque, la clé et le résultat précédent sans afficher leur contenu privé.

Une interruption brutale peut laisser `.backup.lock` et un dossier `.working-*` contenant un instantané **en clair**, protégés par0700/0600. Le prochain passage refuse de travailler. Vérifier qu’aucun job n’est actif, identifier exactement ces artefacts de ce service, puis traiter le staging abandonné avant de retirer le verrou. Ne jamais supprimer seulement le verrou et oublier l’instantané privé ; ne jamais lancer de purge générale du dossier ou du serveur.

Après un dépassement de budget, conserver les points existants et décider d’une augmentation autorisée de capacité ou d’une politique publiée. Ne pas réduire silencieusement la conservation. Un timer actif avec plusieurs passages en échec n’est pas un système de sauvegarde opérationnel : le suivi et un canal d’alerte restent indispensables.

## Restauration et suppression des comptes

Fermer l’accès public, arrêter uniquement l’application, garder la base actuelle comme retour arrière et restaurer vers un **nouveau** chemin. Ne pas écraser un SQLite actif ni réutiliser ses anciens WAL/SHM. Vérifier intégrité, version de schéma, droits, expiration des contenus et comptes ; rejouer les demandes d’effacement intervenues après le point restauré avant toute réouverture. La source opérationnelle permettant cette réconciliation doit être organisée avant public.

Une suppression du compte dans la base active n’efface pas instantanément une ancienne archive chiffrée. Publier la durée de conservation réellement appliquée et la procédure correspondante avant d’ouvrir le service. Le modèle de7jours ne constitue pas à lui seul une preuve de rotation en exploitation.

## Limites restantes

Un timer sur le VPS produit des points sur ce même VPS : il ne protège pas contre sa perte. Organiser le transfert automatique hors serveur, le suivi de l’âge du dernier point hors serveur, la garde secondaire de la clé et une alerte opérationnelle. Un Mac éteint ou endormi ne fournit pas une disponibilité permanente de transfert. Aucun objectif RPO/RTO contractuel n’est annoncé.
