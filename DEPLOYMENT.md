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

Pour restaurer, arrêter le service, conserver un retour arrière, déchiffrer dans un nouveau fichier, contrôler `PRAGMA integrity_check`, permissions et contenu, puis démarrer sur cette base. Ne pas mélanger le fichier restauré avec d’anciens WAL/SHM. Rejouer les tests d’accès avant réouverture.

## Avant d’ouvrir au public

Renseigner l’entité opératrice, son contact, l’hébergeur, les règles applicables et les informations de confidentialité. La page `public/privacy.html` fournie est explicitement une page de validation à finaliser. Vérifier signalement, blocage, suppression, récupération, sauvegarde et restauration sur l’instance déployée. Ne pas présenter un simple démarrage comme une validation de production.

L’application utilise des tuiles OpenStreetMap chargées par le navigateur ; respecter leur attribution et leur politique de service. Le catalogue local GeoNames n’est pas un géocodeur exhaustif. Aucun dispositif de collecte de groupes privés n’est fourni.

## Mise à niveau des signalements

La table d’attribution conserve les identifiants internes des personnes concernées jusqu’à la suppression du signalement, afin que l’effacement d’un compte fonctionne aussi après retrait ou expiration du contenu. Une ancienne base est renseignée automatiquement si les cibles existent encore. Si une preuve ancienne n’a plus de cible attribuable, le démarrage échoue avec `legacy_report_attribution_required` : conserver la sauvegarde et résoudre cette migration avec l’opérateur, sans deviner une identité ni effacer la preuve silencieusement. Tester la migration sur une copie avant de basculer une instance existante.
