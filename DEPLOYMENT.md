# Déployer une instance

Ce document décrit les prérequis techniques, pas une certification de conformité ou de disponibilité.

## Isolation

Utiliser un compte système dédié, un répertoire d’état privé 0700 et un SQLite 0600. Le fichier d’environnement, les clés et les sauvegardes ne doivent pas être placés dans `public/` ni dans Git. Le service exemple `deploy/thesocialextra.service` limite mémoire et accès au système ; adapter ses chemins avant installation. Ne pas exposer directement le port Node.

Variables : `PUBLIC_ORIGIN` avec l’origine HTTPS exacte, `DATABASE_PATH` absolu, `HOST`, `PORT`, `MODERATOR_IDS` et éventuellement `TRUSTED_PROXY_IPS`. Les modérateurs sont désignés par l’opérateur ; le premier inscrit ne reçoit jamais ce rôle automatiquement.

Un reverse proxy TLS doit préserver Host et réécrire correctement les en-têtes réseau. Par défaut, X-Forwarded-For est ignoré. N’ajouter à TRUSTED_PROXY_IPS que des adresses de proxy mesurées et maîtrisées, jamais une valeur fournie par le client.

## Limites du pilote

Comptes : 10 000 ; annonces : 10 000 ; discussions : 10 000 ; messages : 200 000 au total et 200 par discussion. Les quotas ne sont pas une preuve de charge supportée. Les signalements sont limités à 5 000 et leurs preuves à 16 Kio ; une conversation longue produit un extrait avec omissions indiquées. La rétention des signalements est de 30 jours. Prévoir un traitement humain, une procédure d’urgence, une surveillance et un budget de stockage/trafic.

Deux calculs de mot de passe scrypt au maximum sont acceptés simultanément. Les requêtes sont limitées par adresse et compte, mais ces protections ne remplacent pas la protection réseau contre une attaque distribuée. Les contenus ne sont pas chiffrés de bout en bout.

## Sauvegardes

`backup.mjs` produit un instantané SQLite cohérent en ligne. `ops/backup-crypto.mjs` chiffre et authentifie une copie avec AES256GCM. Utiliser des chemins absolus distincts, une clé en mode 0600 stockée séparément, et une destination hors de la machine de production. La clé est créée seulement si elle n’existe pas ; ne jamais l’afficher ou la commiter.

```sh
node backup.mjs /etat/app.sqlite /sauvegardes/snapshot.sqlite
node ops/backup-crypto.mjs encrypt /sauvegardes/snapshot.sqlite /hors-machine/snapshot.tseb /cles/backup.key
node ops/backup-crypto.mjs decrypt /hors-machine/snapshot.tseb /restauration/app.sqlite /cles/backup.key
```

Planifier rotation, alertes et essais de restauration. La copie ponctuelle ne suffit pas. Perdre la clé rend la sauvegarde inutilisable. Supprimer les temporaires en clair après contrôle. La durée de conservation des sauvegardes et le traitement d’une suppression de compte doivent être publiés par l’opérateur.

Pour restaurer, fermer l’accès public, arrêter le service, conserver un retour arrière et déchiffrer dans un nouveau fichier. Contrôler `PRAGMA integrity_check`, permissions, schéma, contenu et expirations ; ne pas mélanger le fichier restauré avec d’anciens WAL/SHM. **Ne pas rouvrir le service avant d’avoir rejoué les demandes d’effacement intervenues après ce point et vérifié les accès.** Une archive intègre peut contenir des comptes supprimés depuis. La source complète permettant cette réconciliation doit être organisée séparément : ce dépôt ne fournit pas de journal indépendant des effacements et le contrôle SQLite ne le remplace pas. En l’absence de cette source et de preuve du rejeu, garder l’accès public fermé. Voir [la procédure de restauration](BACKUP.md#restauration-et-suppression-des-comptes).

Pour la récupération planifiée, `ops/backup-pull-job.mjs` écrit une attestation privée de chaque tentative et conserve le dernier point vérifié en cas d’échec. Son contrôle local `--check` ne fait aucun SSH ni nouvelle vérification cryptographique. Un point de plus de36heures ou une dernière tentative de plus de3heures ne donne pas un état sain, même si une archive reste récupérable dans les7jours de conservation. Ces seuils sont provisoires, sans SLA. Voir [les commandes, permissions et limites](BACKUP.md#passage-planifié-et-contrôle-de-fraîcheur). L’ordonnanceur, la disponibilité du Mac, l’observateur indépendant et l’alerte humaine restent à organiser ; la seule présence du statut ne prouve pas une surveillance effective.

## Avant d’ouvrir au public

Renseigner l’entité opératrice, son contact, l’hébergeur, les règles applicables et les informations de confidentialité. La page `public/privacy.html` fournie est explicitement une page de validation à finaliser. Vérifier signalement, blocage, suppression, récupération, sauvegarde et restauration sur l’instance déployée. Ne pas présenter un simple démarrage comme une validation de production.

L’application utilise des tuiles OpenStreetMap chargées par le navigateur ; respecter leur attribution et leur politique de service. Le catalogue local GeoNames n’est pas un géocodeur exhaustif. Aucun dispositif de collecte de groupes privés n’est fourni.

## Mise à niveau des signalements

La table d’attribution conserve les identifiants internes des personnes concernées jusqu’à la suppression du signalement, afin que l’effacement d’un compte fonctionne aussi après retrait ou expiration du contenu. Une ancienne base est renseignée automatiquement si les cibles existent encore. Si une preuve ancienne n’a plus de cible attribuable, le démarrage échoue avec `legacy_report_attribution_required` : conserver la sauvegarde et résoudre cette migration avec l’opérateur, sans deviner une identité ni effacer la preuve silencieusement. Tester la migration sur une copie avant de basculer une instance existante.

## Vocaux facultatifs

Les routes d’envoi ne sont activées que si l’opérateur définit `VOICE_SOCKET` sur un chemin Unix absolu maîtrisé. Le serveur web ne lance aucun décodeur : il contacte `voice-worker.mjs` par ce socket privé. Le worker ne doit jamais être routé vers Internet. Il ne possède pas d’authentification applicative ; les permissions Unix et le confinement constituent sa frontière de sécurité.

Le modèle `deploy/thesocialextra-voice.service` attend un utilisateur système distinct, `thesocialextra-voice`, dans le groupe du service web `thesocialextra`. Son répertoire de socket est en 0750 et son socket en 0660. Il masque les répertoires de données et de secrets de l’application, utilise un espace réseau privé, n’autorise que les sockets Unix et limite la mémoire à 256 Mio. Vérifier les propriétés réellement appliquées, la lecture refusée des fichiers sensibles et un aller-retour synthétique avant toute activation. Adapter les chemins sans élargir les droits. FFmpeg et ffprobe doivent provenir d’une distribution maîtrisée et rester corrigés.

Entrées : WebM, Ogg ou MP4, 5 Mio maximum. Sortie : Opus mono, 512 Kio maximum et 60 secondes de son réellement décodé. Le client s’arrête avant cette limite pour garder une marge ; le serveur refuse une durée excessive au lieu d’accepter une troncature. Les métadonnées d’origine sont retirées. Un seul traitement est admis à la fois, sans file d’attente ; une saturation laisse le texte disponible.

Quotas du pilote : 20 vocaux par discussion, 20 Mio par expéditeur, 200 Mio de vocaux actifs au total et 50 Mio de copies vocales dans les signalements. Ces plafonds ne constituent pas une mesure de charge. Les copies des preuves suivent la conservation de 30 jours et l’effacement du compte concerné ; elles peuvent survivre à un retrait par modération. Une capacité insuffisante refuse le nouveau signalement sans supprimer les preuves antérieures. Prévoir un canal de recours humain distinct.

Le micro n’est demandé qu’après un clic. Aucun enregistrement n’est envoyé automatiquement ; il peut être réécouté et effacé. Le texte reste disponible si le navigateur ne permet pas l’enregistrement ou la lecture. Les navigateurs et appareils ciblés doivent être testés réellement avant diffusion.

## Suppression depuis le web et sauvegarde planifiée

La page `/delete-account.html` propose un chemin vers le formulaire de compte sans installation mobile. Un lien ne supprime jamais le compte : connexion ou récupération, phrase secrète et confirmation restent nécessaires. La politique de sauvegarde doit expliquer les limites de cet effacement.

Le modèle de job quotidien et ses limites sont détaillés dans [BACKUP.md](BACKUP.md). Il vérifie une restauration avant de publier un point chiffré et refuse une capacité insuffisante avant la copie, journal WAL compris. Ne pas confondre un timer local avec un transfert hors machine ou un dispositif d’alerte.

## Règles versionnées

Le document courant est identifié dans `rules.mjs` et servi depuis les octets dont le SHA256 a été vérifié au démarrage. Ne modifiez jamais le texte d’une version déjà publiée : ajoutez un nouveau fichier et une nouvelle version avec sa nouvelle empreinte. Le catalogue SQLite refuse de réutiliser une version avec un autre contenu. L’accord est requis pour publier, rouvrir ou envoyer ; un ancien compte conserve lecture, sécurité et suppression sans accord rétroactif. Le document initial décrit un pilote, pas des conditions légales finalisées.


## Présentation facultative avec photo et vidéo

`PRESENTATION_SOCKET` active les routes seulement après installation d’un worker privé distinct. Le modèle `deploy/thesocialextra-presentation.service` utilise un utilisateur dédié sans accès à la base, aux secrets ni aux sauvegardes, le groupe du serveur pour le socket0660, un réseau privé, AF_UNIX seulement,512Mio mémoire, CPU50%,32tâches et24Mio par fichier. Les temporaires ont des montages séparés de96Mio et8Mio. Ces valeurs sont des limites, pas une capacité garantie. Vérifier l’isolation réellement appliquée et un aller-retour synthétique avant activation ; ne pas exposer le socket au réseau. Le worker requiert des versions maintenues de FFmpeg/ffprobe ; le dépôt ne télécharge ni ne met à jour ces outils.

Photos fixes JPEG/PNG/WebP :8Mio/12mégapixels, sortieJPEG1600px/1Mio maximum, orientation appliquée, métadonnées retirées. Vidéo MP4 ou QuickTime récent H264/HEVC/AAC et WebM VP8/VP9/Opus/Vorbis :20Mio/1080p/30images/s/15s, sortieH264/AACmono720px/8Mio. PQ/HLG et indicationsBT.2020 sont refusés sans conversion HDR ; la sortie ne tronque pas silencieusement une entrée excessive. Une seule conversion partagée photo/vidéo, sans file d’attente. L’effacement de métadonnées ne masque pas les informations visibles dans une image.

La présentation est un brouillon privé avant publication explicite sur les annonces ouvertes actuelles et futures ; pas d’annuaire public des comptes. Retrait commun immédiat et effacement séparés. Une modification privée ne change pas la publication. Les médias publics ont une URL versionnée dont les autorisations sont revérifiées à chaque lecture, y compris les plages vidéo. Une présentation signalée conserve une preuve de la version effectivement vue, accessible aux modérateurs pendant30jours ; si elle a changé, le signalement est refusé pour éviter une substitution. L’effacement du compte retire aussi ces copies en base active. L’opérateur doit désigner les personnes assurant la modération et un recours humain.

Plafonds présentation du pilote :18Mio par compte,64Mio au total pour les médias actifs (brouillon et publication),16Mio pour les copies de preuve. Tous les contenus SQLite partagent un plafond logique de384Mio. Huit points de sauvegarde complets occupent alors environ3Gio, sous un budget de rétention4Gio. WAL, temporaires, copies manuelles, trafic et espace physique ne sont pas couverts par ce seul calcul. À saturation, une écriture — y compris une nouvelle session — peut être refusée503 sans effacer les données précédentes. Prévoir surveillance, capacité et traitement des demandes, ne pas annoncer une capacité illimitée.

Avant une mise à niveau, tester les migrations et la nouvelle version des règles sur une copie. Garder les anciens documents immuables : la version2026-08-28.2 ajoute la présentation ; les comptes ayant accepté.1 devront accepter.2 avant une nouvelle contribution. Les deux documents fournis restent des règles de pilote à faire valider par l’opérateur avant ouverture réelle.
