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

Fermer l’accès public, arrêter uniquement l’application, garder la base actuelle comme retour arrière et restaurer vers un **nouveau** chemin. Ne pas écraser un SQLite actif ni réutiliser ses anciens WAL/SHM. Vérifier intégrité, version de schéma, droits, expiration des contenus et comptes ; rejouer les demandes d’effacement intervenues après le point restauré avant toute réouverture. Le [journal indépendant](ERASURE.md) et ses outils sont fournis, mais son activation, sa copie hors serveur et une référence actuelle sont à organiser avant public. L’outil de préparation ne donne jamais d’autorisation d’ouverture.

Une suppression du compte dans la base active n’efface pas instantanément une ancienne archive chiffrée. Publier la durée de conservation réellement appliquée et la procédure correspondante avant d’ouvrir le service. Le modèle de7jours ne constitue pas à lui seul une preuve de rotation en exploitation.

## Limites restantes

Un timer sur le VPS produit des points sur ce même VPS : il ne protège pas contre sa perte. Organiser le transfert automatique hors serveur, le suivi de l’âge du dernier point hors serveur, la garde secondaire de la clé et une alerte opérationnelle. Un Mac éteint ou endormi ne fournit pas une disponibilité permanente de transfert. Aucun objectif RPO/RTO contractuel n’est annoncé.

## Récupération hors serveur, à activer séparément

`ops/backup-pull.mjs` permet un passage manuel depuis une autre machine. Cet outil n’installe rien, ne modifie aucune planification et n’écrit pas sur le serveur source. Sa présence dans le dépôt ne prouve pas qu’une copie hors serveur existe ou qu’un transfert automatique fonctionne.

Préparer un fichier JSON privé, en chemin absolu, mode0600, appartenant au compte qui lance l’outil et **hors du dépôt**. Il contient exactement cinq champs : `host` (nom DNS ou `utilisateur@nom`), `identityFile` (clé SSH existante), `remoteDirectory` (dossier des snapshots), `localDirectory` (destination dédiée sur cette autre machine) et `keyFile` (clé AES existante correspondant aux archives). Tous les chemins sont absolus. Ne pas enregistrer une configuration opérationnelle dans Git ; l’outil ne crée ni clé ni compte. Les fichiers locaux de clé sont aussi exigés en0600 et hors du répertoire source.

Lancer `node ops/backup-pull.mjs CHEMIN_ABSOLU_CONFIGURATION_PRIVEE`. OpenSSH doit déjà être installé à `/usr/bin/ssh`, avec la clé d’hôte vérifiée et connue, et Python3 disponible sur le serveur. Le transfert désactive les configurations SSH implicites, proxies, commandes locales et redirections ; les alias dépendant d’un fichier SSH personnalisé ne sont donc pas pris en charge. Il utilise BatchMode, IdentitiesOnly et StrictHostKeyChecking=yes : aucune demande interactive ni acceptation automatique d’une clé inconnue. Vérifier l’empreinte du serveur par un canal maîtrisé avant de configurer cette confiance.

Le Python transmis sur l’entrée standard est constant. Les paramètres sont encodés comme données ; aucune commande de shell libre n’est acceptée. Le dossier distant doit être dédié, mode0700, sans composant de chemin symbolique. Seules les archives régulières privées au nom canonique `snapshot-DATE-UUID.tseb` sont listées et lues. Les listes sont bornées à4096entrées et512Kio, les diagnostics SSH sont ignorés et bornés. Le dernier point datant de moins de7jours est choisi ; un décalage futur supérieur à5minutes n’est pas accepté. La lecture refuse une archive de plus de2Gio+36octets ou dont la taille change. Le transport ne suffit pas à limiter les droits du compte SSH : l’opérateur doit choisir un compte et des droits adaptés à la lecture des archives, sans prétendre que cet outil confine un accès SSH plus large.

### Clé de transfert dédiée et commande forcée

Pour une planification, ne pas réutiliser une clé SSH d’administration générale. `ops/backup-readonly.py` est un helper à installer séparément comme commande forcée d’une **clé dédiée**. Il reste compatible avec le protocole de `backup-pull.mjs` : le client envoie son script constant, mais le helper le jette sans jamais l’exécuter. Il ne lance aucun sous-processus. Il accepte uniquement les quatre tokens `python3`, `-I`, `-`, puis un paramètre base64 contenant un objet JSON strict. Le dossier demandé doit correspondre exactement au dossier fixé dans la commande forcée ; seules les opérations `list` et `read`, avec leurs champs prévus, sont acceptées. Les doublons JSON, champs supplémentaires et commandes de shell sont refusés.

Exemple **non opérationnel**, chemins et clé à remplacer après revue ; aucune installation n’est effectuée par ce dépôt :

```text
restrict,command="/usr/bin/python3 -I /etc/backup-example/reader.py /var/backups/backup-example" ssh-ed25519 PUBLIC_KEY_PLACEHOLDER
```

Cette ligne est destinée au fichier `authorized_keys` du compte choisi. `restrict` désactive notamment terminal, redirections et exécution du fichier SSH utilisateur ; `command` impose le helper pour cette clé. Le helper, ses répertoires parents et cette autorisation doivent être détenus et modifiables seulement par l’opérateur, jamais par le compte applicatif. Le chemin de l’interpréteur est absolu et Python est lancé avec `-I`. Ne pas stocker de clé AES, base en clair ou autre secret dans le dossier des snapshots. Ne pas élargir les permissions de ce dossier pour rendre la copie possible.

Si les archives sont détenues par root en0700, une clé dédiée rattachée à root et portant **cette commande forcée** n’est pas une clé root libre : son protocole ne donne accès qu’aux archives canoniques de ce dossier. Cette restriction s’applique à cette seule entrée, pas aux autres clés, mots de passe, configurations SSH ou accès administrateur du serveur. Le processus conserve les privilèges de son compte : ce helper n’est ni un sandbox OS ni une garantie contre une mauvaise configuration ou sa modification par un administrateur. Un compte distinct reste possible si les droits privés des archives sont organisés pour lui, sans ouverture au groupe ou au monde. Vérifier séparément la politique du serveur SSH, les limites de sessions et les propriétés réellement appliquées avant activation.

Le helper ouvre chaque composant du dossier sans suivre de lien symbolique et exige0700 sur le dossier final. Il ne liste ni ne lit les fichiers étrangers, liens symboliques, répertoires ou archives accessibles au groupe ou au monde. Le nom et la date du snapshot sont validés ; la taille déclarée doit correspondre à la taille réelle, de36octets à2Gio+36octets. La copie se fait par blocs de64Kio ; une troncature ou croissance détectée entraîne un échec. Le scan compte aussi les entrées étrangères dans sa limite de4096 et ne publie pas de liste partielle. Le stdin est ignoré avec une borne de64Kio et un délai de5secondes jusqu’à sa fermeture ; le contenu reçu ne peut pas remplacer le helper. Toute erreur renvoie seulement un statut1, sans chemin ni traceback. Une lecture interrompue peut avoir déjà émis des octets : le client doit continuer à vérifier le statut, la taille, AES-GCM et SQLite avant publication locale.

Avant planification, tester avec cette clé dédiée la liste et une restauration réelle, puis vérifier que shell libre, autre dossier, lecture de clé, terminal et redirections sont refusés. Les tests du dépôt exécutent de vrais processus Python **locaux** et adaptent le transport client sans réseau ; ils ne prouvent pas l’installation de la commande forcée ni la configuration d’un serveur SSH.

La destination est dédiée, en0700, hors du répertoire source ; son dossier parent doit déjà exister. Un verrou `.pull.lock` exclut deux passages. La réception est progressive vers un staging privé0600 ; avant de commencer, l’outil contrôle un budget de4Gio pour les points encore retenus et un espace disponible d’au moins1Gio plus trois fois la taille reçue et1Mio de marge. Ces estimations ne réservent pas le disque contre les écritures d’autres programmes. Le délai total par défaut est de120secondes ; la bibliothèque permet de le régler jusqu’à15minutes, sans option JSON de contournement.

L’archive reçue est déchiffrée avec AES-GCM et sa restauration SQLite est contrôlée dans un sous-processus Node avant publication exclusive. La clé est transmise par IPC, jamais dans les arguments ni dans l’environnement. Le délai peut terminer ce processus même pendant un appel SQLite natif synchrone. Ce processus limite le tas JavaScript et le cache SQLite ; il ne constitue pas un sandbox système ni une limite absolue de mémoire native. Le texte clair temporaire est nettoyé après succès ou échec ordinaire. Un point déjà présent est revérifié localement, sans téléchargement, remplacement ni rotation. Une archive corrompue, une clé erronée, un budget insuffisant ou un transport interrompu ne supprime aucun ancien point. Après un **nouveau** point vérifié, seuls les points canoniques réguliers strictement antérieurs à7jours sont retirés ; les points jeunes, la borne exacte, les dates futures, les fichiers étrangers et les liens symboliques sont conservés.

Le résultat ne contient que le nom canonique du point, sa taille, le contrôle d’intégrité, l’indication de présence antérieure et le nombre de points retirés. Une erreur est un code générique, sans clé, contenu SQLite, chemin privé ni diagnostic distant. Une panne brutale peut laisser `.pull.lock` et `.pull-working-*` contenant du texte clair en0700/0600. Le prochain passage refuse de démarrer : inspecter ces seuls artefacts, vérifier l’absence de processus actif et traiter le staging avant de retirer le verrou. Un échec du nettoyage conserve aussi le verrou. Un échec après publication peut laisser un nouveau point utilisable tout en renvoyant une erreur ; inspecter avant toute intervention, sans purge générale.

Avant une planification, faire un passage réel, une restauration indépendante et un contrôle métier non vide, puis vérifier les permissions, l’âge du point obtenu et le nettoyage. La planification, le rattrapage après veille, l’alerte opérationnelle, la garde secondaire de la clé et la réconciliation des suppressions de comptes restent à organiser séparément. Aucun transfert réel ni disponibilité continue n’est démontré par les tests synthétiques de cet outil.

### Passage planifié et contrôle de fraîcheur

Pour un ordonnanceur, `ops/backup-pull-job.mjs` enveloppe le transfert et écrit une attestation locale distincte. Il n’installe ni tâche ni notification. Les deux arguments sont des chemins absolus privés hors du dépôt : configuration existante0600, puis fichier de statut. Le dossier parent du statut doit déjà exister en0700, appartenir au compte courant et avoir un chemin canonique sans lien symbolique. Un statut existant doit être un fichier régulier0600 de ce même compte, sans lien symbolique ou physique supplémentaire. Choisir un dossier de statut séparé, jamais une clé ou une archive comme destination.

```text
node ops/backup-pull-job.mjs CONFIGURATION_ABSOLUE_PRIVEE STATUT_ABSOLU_PRIVE
node ops/backup-pull-job.mjs --check STATUT_ABSOLU_PRIVE
```

Le passage écrit d’abord la tentative en cours, puis son résultat. Il conserve le dernier point vérifié en cas d’échec. Le statut compact versionné contient seulement les dates de tentative et de fin, l’état, un code d’erreur autorisé et le dernier point vérifié : nom canonique, taille, date du snapshot et date de vérification. Aucun chemin, configuration, clé ou diagnostic arbitraire n’y entre. La lecture est bornée à8Kio et refuse les champs inattendus, doublons JSON ou formats non générés par le job. Un statut absent ou corrompu n’est pas une preuve de succès ; un statut corrompu n’est pas écrasé automatiquement.

Les mises à jour passent par un fichier temporaire0600, une synchronisation des données, une publication atomique et une synchronisation du dossier. Le verrou exclusif `STATUT.lock` empêche les passages concurrents sur ce statut. Aucun verrou préexistant n’est supprimé automatiquement. Une interruption ou un échec de publication peut laisser un verrou, un statut en cours ou un temporaire de métadonnées : inspecter ces seuls artefacts et vérifier qu’aucun passage n’est actif avant intervention. Ne pas réutiliser cette procédure pour purger les clés, archives ou staging de restauration.

**La fraîcheur est séparée de la conservation.** Le transfert peut encore récupérer un point utile de moins de7jours, mais le wrapper signale `snapshot_stale` et termine avec un code non nul si le point dépasse36heures. Ce seuil est une règle opérationnelle provisoire pour un backup quotidien, pas un SLA ni un engagement RPO. Une date future de plus de5minutes est refusée. Vérifier les horloges des machines.

`--check` ne modifie rien, ne se connecte pas au serveur et ne lit ni configuration, clé ni archive. Il réévalue l’âge à l’instant du contrôle : le dernier passage doit être réussi, sa tentative dater d’au plus3heures et le point d’au plus36heures. La borne de3heures suppose des passages Mac plus fréquents ; elle est également provisoire. Un verrou présent, une tentative encore en cours, un échec, un statut absent/corrompu ou un âge excessif donne un code non nul. La sortie JSON `{ok,error,status}` permet un contrôle automatisé ; seules les métadonnées et les codes autorisés sont affichés. La commande lit **l’attestation du job**, elle ne refait pas AES-GCM ou SQLite, ne confirme pas que l’archive est toujours présente et ne prouve pas la réconciliation des comptes effacés.

Ce contrôle ne déclenche pas lui-même d’alerte humaine. Un Mac endormi, arrêté ou sans ordonnanceur ne lance ni transfert ni contrôle. Un observateur indépendant, son destinataire et une procédure de traitement restent nécessaires pour détecter une absence de passage ; leur choix et leur disponibilité doivent être validés avant de présenter les sauvegardes comme surveillées.
