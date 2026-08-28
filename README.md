# thesocialextra

Des annonces locales et des conversations privées pour trouver un renfort ou une mission dans les métiers de l’hospitalité. Publier, chercher et discuter restent gratuits dans le produit.

**Version en validation.** Le code est fourni sous licence MIT ; il ne constitue pas une plateforme clé en main conforme à toutes les obligations d’un opérateur. Comptes, stockage durable, modération et sauvegardes sont implémentés et testés, mais l’exploitation humaine, les mentions opérateur et le déploiement public doivent être préparés. Aucune publication Google Play n’est annoncée.

## Deux serveurs distincts

Node.js 24.12 ou supérieur. Aucune dépendance npm à installer. Les tests médias et les options vocal/photo/vidéo nécessitent FFmpeg et ffprobe avec les codecs correspondants (notamment libopus et libx264). Les versions 6.1.1 (Linux) et 9.0.1 (Mac) ont été testées ; le service texte peut fonctionner sans ces binaires. `node:sqlite` est encore expérimental dans la version 24.13 vérifiée.

```sh
# Démonstration locale, données fictives et volatiles
node server.mjs

# Tests automatisés, sans service tiers
node --test tests/*.test.mjs
```

Le serveur durable ne crée pas de faux utilisateurs ni de fausses annonces :

```sh
ALLOW_LOCAL_HTTP=true PUBLIC_ORIGIN=http://127.0.0.1:4179 DATABASE_PATH="$PWD/.runtime/app.sqlite" PORT=4179 node production-server.mjs
```

Ouvrir ensuite l’adresse locale 4179. HTTP est autorisé uniquement en mode loopback explicite ; une publication nécessite HTTPS. Ne pas importer les données de démonstration dans le service durable.

## Fonctionnement

- Consultation libre ; pseudo et phrase secrète pour publier et échanger. Code de secours, sessions révocables et suppression de compte accessible depuis le web.
- Annonces visibles 30 min, 1 h, 2 h ou 4 h. Places confirmées manuellement ; un message ne réserve rien. Les annonces pourvues quittent le fil.
- Douze métiers, carte et fil, recherche par ville et localisation approximative facultative. Catalogue GeoNames de grandes localités, non exhaustif.
- Préparation privée d’événements : horaires, besoins par métier, langues, consignes et confirmations manuelles. Après enregistrement, chaque besoin peut devenir une annonce indépendante, relue avant publication ; les consignes privées ne sont pas copiées. Les dates de mission et la durée de visibilité de l’annonce restent distinctes.
- Accord versionné aux règles de publication, vérifié côté serveur avant les nouvelles contributions ; lecture, sécurité et suppression restent accessibles. Le document fourni est un pilote à remplacer par une nouvelle version validée avant ouverture.
- Blocage depuis une annonce sans contact préalable, masquage du fil et de la carte pour le compte connecté, gestion des blocages même après expiration du contenu.
- Conversations privées, messages texte et vocaux facultatifs, blocage et signalements. Conservation jusqu’à sept jours après expiration publique, sauf suppression ou modération.
- Liens partageables ville/métier/type sans compte ni coordonnées personnelles. Aucun import de groupe, collecte massive ni publication automatique.
- Installation web facultative. Hors connexion, une page statique explique l’indisponibilité ; aucune annonce ni conversation n’est mise en cache par le service worker.
- Aucun paiement ni contrat traité. The Notice est un lien vers un service distinct, sans transfert automatique des comptes.

Les identités, autorisations de travail et compétences ne sont pas vérifiées par ce logiciel. Les vocaux restent désactivés tant qu’un service de conversion isolé n’est pas configuré. La présentation facultative (bio, photo et vidéo de15secondes avec résumé écrit) reste également désactivée sans un worker isolé distinct et PRESENTATION_SOCKET. Choisir un fichier ne l’envoie pas ; un envoi explicite crée un brouillon privé, puis une publication explicite le rend visible depuis les annonces ouvertes. Le micro est facultatif ; l’enregistrement est réécoutable avant un envoi explicite. Aucun test sur microphone physique ni publication sur téléphone n’est revendiqué ici.

## Exploiter et contribuer

[Déploiement et limites](DEPLOYMENT.md) · [Sauvegardes](BACKUP.md) · [Effacement et restauration](ERASURE.md) · [Sécurité](SECURITY.md) · [Ressources tierces](THIRD-PARTY-NOTICES.md).

Proposez des changements limités, accompagnés de tests du comportement modifié. N’ajoutez jamais de données personnelles, secrets, bases de production ou captures privées aux issues et pull requests. Les tests utilisent des fixtures synthétiques. `CI-example.yml` fournit un exemple GitHub Actions, mais aucun workflow automatique n’est activé dans ce dépôt à sa publication : le jeton de publication n’a pas le droit de créer des workflows. Les tests ont été exécutés localement ; aucun résultat CI distant n’est revendiqué.

## Licence

[MIT](LICENSE) pour le code original. Les ressources tierces gardent leurs licences respectives. Cette licence autorise aussi les forks commerciaux ; elle ne garantit pas leurs prix, leur hébergement ou leur fonctionnement.

Les filtres de recherche (métier, type, quartier, anglais, véhicule) et le tri sont appliqués par le serveur avant le plafond de200annonces affichées. Si davantage correspondent, l’interface indique la limite et invite à préciser la recherche. Un lien direct vers une annonce active reste consultable et contactable même hors de cette sélection.
