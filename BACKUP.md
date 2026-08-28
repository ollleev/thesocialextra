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

## Récupération hors serveur, à activer séparément

`ops/backup-pull.mjs` permet un passage manuel depuis une autre machine. Cet outil n’installe rien, ne modifie aucune planification et n’écrit pas sur le serveur source. Sa présence dans le dépôt ne prouve pas qu’une copie hors serveur existe ou qu’un transfert automatique fonctionne.

Préparer un fichier JSON privé, en chemin absolu, mode0600, appartenant au compte qui lance l’outil et **hors du dépôt**. Il contient exactement cinq champs : `host` (nom DNS ou `utilisateur@nom`), `identityFile` (clé SSH existante), `remoteDirectory` (dossier des snapshots), `localDirectory` (destination dédiée sur cette autre machine) et `keyFile` (clé AES existante correspondant aux archives). Tous les chemins sont absolus. Ne pas enregistrer une configuration opérationnelle dans Git ; l’outil ne crée ni clé ni compte. Les fichiers locaux de clé sont aussi exigés en0600 et hors du répertoire source.

Lancer `node ops/backup-pull.mjs CHEMIN_ABSOLU_CONFIGURATION_PRIVEE`. OpenSSH doit déjà être installé à `/usr/bin/ssh`, avec la clé d’hôte vérifiée et connue, et Python3 disponible sur le serveur. Le transfert désactive les configurations SSH implicites, proxies, commandes locales et redirections ; les alias dépendant d’un fichier SSH personnalisé ne sont donc pas pris en charge. Il utilise BatchMode, IdentitiesOnly et StrictHostKeyChecking=yes : aucune demande interactive ni acceptation automatique d’une clé inconnue. Vérifier l’empreinte du serveur par un canal maîtrisé avant de configurer cette confiance.

Le Python transmis sur l’entrée standard est constant. Les paramètres sont encodés comme données ; aucune commande de shell libre n’est acceptée. Le dossier distant doit être dédié, mode0700, sans composant de chemin symbolique. Seules les archives régulières privées au nom canonique `snapshot-DATE-UUID.tseb` sont listées et lues. Les listes sont bornées à4096entrées et512Kio, les diagnostics SSH sont ignorés et bornés. Le dernier point datant de moins de7jours est choisi ; un décalage futur supérieur à5minutes n’est pas accepté. La lecture refuse une archive de plus de2Gio+36octets ou dont la taille change. Le transport ne suffit pas à limiter les droits du compte SSH : l’opérateur doit choisir un compte et des droits adaptés à la lecture des archives, sans prétendre que cet outil confine un accès SSH plus large.

La destination est dédiée, en0700, hors du répertoire source ; son dossier parent doit déjà exister. Un verrou `.pull.lock` exclut deux passages. La réception est progressive vers un staging privé0600 ; avant de commencer, l’outil contrôle un budget de4Gio pour les points encore retenus et un espace disponible d’au moins1Gio plus trois fois la taille reçue et1Mio de marge. Ces estimations ne réservent pas le disque contre les écritures d’autres programmes. Le délai total par défaut est de120secondes ; la bibliothèque permet de le régler jusqu’à15minutes, sans option JSON de contournement.

L’archive reçue est déchiffrée avec AES-GCM et sa restauration SQLite est contrôlée dans un sous-processus Node avant publication exclusive. La clé est transmise par IPC, jamais dans les arguments ni dans l’environnement. Le délai peut terminer ce processus même pendant un appel SQLite natif synchrone. Ce processus limite le tas JavaScript et le cache SQLite ; il ne constitue pas un sandbox système ni une limite absolue de mémoire native. Le texte clair temporaire est nettoyé après succès ou échec ordinaire. Un point déjà présent est revérifié localement, sans téléchargement, remplacement ni rotation. Une archive corrompue, une clé erronée, un budget insuffisant ou un transport interrompu ne supprime aucun ancien point. Après un **nouveau** point vérifié, seuls les points canoniques réguliers strictement antérieurs à7jours sont retirés ; les points jeunes, la borne exacte, les dates futures, les fichiers étrangers et les liens symboliques sont conservés.

Le résultat ne contient que le nom canonique du point, sa taille, le contrôle d’intégrité, l’indication de présence antérieure et le nombre de points retirés. Une erreur est un code générique, sans clé, contenu SQLite, chemin privé ni diagnostic distant. Une panne brutale peut laisser `.pull.lock` et `.pull-working-*` contenant du texte clair en0700/0600. Le prochain passage refuse de démarrer : inspecter ces seuls artefacts, vérifier l’absence de processus actif et traiter le staging avant de retirer le verrou. Un échec du nettoyage conserve aussi le verrou. Un échec après publication peut laisser un nouveau point utilisable tout en renvoyant une erreur ; inspecter avant toute intervention, sans purge générale.

Avant une planification, faire un passage réel, une restauration indépendante et un contrôle métier non vide, puis vérifier les permissions, l’âge du point obtenu et le nettoyage. La planification, le rattrapage après veille, l’alerte opérationnelle, la garde secondaire de la clé et la réconciliation des suppressions de comptes restent à organiser séparément. Aucun transfert réel ni disponibilité continue n’est démontré par les tests synthétiques de cet outil.
