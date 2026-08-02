# Jorgarde Automator

Application Windows autonome pour automatiser l’inscription à vos propres services self-hosted avec Chromium et l’API de réception JorgardeMail.

Elle crée une adresse API, remplit le formulaire enregistré, attend le message de validation et ouvre son lien — ou saisit le code reçu. Elle ne peut pas envoyer d’e-mail et ne contourne aucun CAPTCHA, aucune MFA et aucune protection du service.

## Le chemin simple

L’application s’ouvre maintenant sur **Démarrage guidé**. Suivez simplement les quatre boutons affichés :

1. **Configurer l’API** : collez l’URL de JorgardeMail et votre clé, puis testez la connexion.
2. **Créer / enregistrer** : indiquez le nom et la page d’inscription de votre service. Chromium s’ouvre; remplissez le formulaire une fois puis cliquez sur **Arrêter** dans Jorgarde Automator.
3. **Générer maintenant** : l’outil produit un username, une adresse aléatoire et un mot de passe fort.
4. **Lancer la création** : Chromium rejoue le formulaire avec ces nouveaux identifiants.

Le panneau **Suivi en direct** explique ce que fait l’application. Le bouton **Pause / contrôle manuel** permet de reprendre la main dans Chromium. L’onglet **Scénario avancé** reste disponible, mais il n’est pas nécessaire pour lancer un profil déjà préparé.

Chaque adresse réellement créée produit automatiquement une fiche dans **Mes comptes** avec le service, le username, l’email, le statut et le mot de passe. Le mot de passe est stocké dans le coffre Windows, jamais dans la fiche JSON. Vous pouvez afficher, copier ou supprimer cette fiche; sa suppression ne supprime pas le compte distant.

## Installation

1. Téléchargez ou copiez ce dossier sur votre ordinateur Windows.
2. Double-cliquez sur `INSTALLER.bat`.
3. Double-cliquez sur `RUN.bat` ou utilisez le raccourci créé sur le Bureau.

L’installateur crée un environnement Python isolé, installe PySide6 Essentials, Playwright et un seul Chromium utilisé dans les modes visible et headless. Si Python est absent et que `winget` est disponible, il propose automatiquement Python 3.12 pour votre compte.

## Configuration manuelle de l’API

Dans l’onglet **JorgardeMail** :

1. saisissez l’URL de l’application, par exemple `http://192.168.0.56:6969` ;
2. collez la clé créée dans l’onglet API de JorgardeMail ;
3. cliquez sur **Tester et charger les domaines** ;
4. activez la mémorisation seulement si vous souhaitez stocker la clé dans le trousseau sécurisé Windows.

La clé n’est jamais écrite dans le fichier de configuration. Sans mémorisation, elle reste seulement en mémoire jusqu’à la fermeture.

## Éditeur de scénario avancé

1. Cliquez sur **Nouveau** et saisissez la page d’inscription de votre service.
2. Vérifiez les domaines autorisés. Ajoutez les sous-domaines nécessaires avec `*.exemple.local`.
3. Cliquez sur **Enregistrer dans Chromium**.
4. Utilisez normalement le formulaire dans la fenêtre Chromium.
5. Cliquez sur **Arrêter l’enregistrement** dans l’application.
6. Ajoutez une action **Attendre et ouvrir un lien reçu par mail** juste après l’envoi du formulaire, ou une action **Attendre et saisir un code reçu par mail**.
7. Double-cliquez sur une action pour corriger son sélecteur ou ses critères.
8. Enregistrez le profil.

Les champs reconnus sont remplacés pendant l’enregistrement :

- `{{EMAIL}}` : adresse créée par l’API ;
- `{{USERNAME}}` : nom saisi dans l’interface avant l’exécution ;
- `{{PASSWORD}}` : mot de passe saisi dans l’interface, jamais écrit dans le scénario ;
- `{{START_URL}}` : page d’inscription du profil ;
- `{{MAILBOX_ID}}` : identifiant interne de l’adresse API.

Vérifiez toujours l’action enregistrée pour un champ inhabituel. Si un mot de passe apparaît en clair dans une action personnalisée, remplacez-le par `{{PASSWORD}}` avant de sauvegarder.

## Lancer manuellement un scénario

1. sélectionnez le service ;
2. saisissez le nom d’utilisateur et le mot de passe demandés par le scénario ;
3. laissez la partie locale et le domaine vides pour une adresse aléatoire, ou choisissez-les ;
4. choisissez Chromium visible ou le mode headless ;
5. cliquez sur **Lancer le scénario**.

En mode visible, **Pause / prise en main** suspend le moteur et vous laisse contrôler Chromium. Cliquez de nouveau pour reprendre. Utilisez cette pause pour une MFA ou un CAPTCHA légitime ; l’outil ne tente pas de les contourner.

## Actions disponibles

| Action | Fonction |
|---|---|
| `goto` | Ouvre une URL autorisée |
| `click` | Clique sur un élément |
| `fill` | Remplit un champ |
| `select` | Sélectionne une option |
| `check` / `uncheck` | Coche ou décoche |
| `press` | Envoie une touche, par exemple `Enter` |
| `wait_for` | Attend un élément visible, attaché, masqué ou retiré |
| `sleep` | Pause explicite de 30 secondes maximum |
| `wait_email_link` | Attend un mail correspondant et ouvre un lien autorisé |
| `wait_email_code` | Extrait un code avec une expression régulière et le saisit |

Il n’existe aucune action JavaScript arbitraire. Les navigations principales sont bloquées dès qu’elles quittent les domaines autorisés du profil. Les images, polices et scripts CDN utilisés par votre page restent possibles, mais Chromium ne peut pas naviguer vers ces domaines sans autorisation explicite.

## Stockage local

Les profils sont enregistrés dans `%APPDATA%\JorgardeAutomator\workflows` et les fiches sans secret dans `%APPDATA%\JorgardeAutomator\accounts`. Ils peuvent être exportés et importés en JSON. Aucun mot de passe n’est écrit dans ces JSON : les mots de passe des comptes notés et, si vous le demandez, la clé API sont conservés par le coffre sécurisé du système.

L’adresse créée reste disponible dans l’onglet API de JorgardeMail, sauf si **Supprimer l’adresse après succès** est activé.

## Construction de l’exécutable

Après l’installation, lancez `BUILD.bat`. Les tests sont exécutés avant PyInstaller. Le résultat se trouve dans `dist\JorgardeAutomator\` ; Chromium rend ce dossier volumineux, ce qui est normal.

Pour distribuer la version construite, copiez le dossier `JorgardeAutomator` complet ou son archive ZIP. L’exécutable dépend du sous-dossier `_internal` placé à côté de lui.

## Portée autorisée

Utilisez cet outil uniquement sur les services que vous possédez ou pour lesquels vous avez une autorisation explicite. Il est conçu pour éliminer les tâches répétitives de votre infrastructure, pas pour créer des comptes en masse sur des services publics.
