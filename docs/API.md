# API développeur JorgardeMail

L’API JorgardeMail est volontairement limitée à la création d’adresses temporaires aléatoires et à la lecture des e-mails qu’elles reçoivent. Elle ne propose aucun endpoint d’envoi.

L’administrateur doit d’abord activer l’accès API pour l’utilisateur depuis **Administration → Utilisateurs → Gérer**. L’utilisateur peut ensuite créer jusqu’à cinq clés dans l’onglet **API développeur**. Le secret complet n’est affiché qu’une fois.

## Authentification

Chaque requête doit transmettre la clé dans l’en-tête HTTP:

```http
Authorization: Bearer jm_VOTRE_CLE
```

Ne placez jamais une clé dans du JavaScript public ou dans un dépôt Git. La révocation d’une clé ou le retrait de l’accès API prend effet immédiatement.

## Créer une adresse temporaire

`POST /api/v1/mailboxes`

```bash
curl -X POST "https://votre-serveur/api/v1/mailboxes" \
  -H "Authorization: Bearer VOTRE_CLE" \
  -H "Content-Type: application/json" \
  -d '{"ttl_minutes":60}'
```

`ttl_minutes` est optionnel, vaut 60 par défaut et doit être un entier compris entre 10 et 1 440. L’adresse est aléatoire, utilise un domaine actif et compte dans le quota de l’utilisateur.

Réponse `201`:

```json
{
  "mailbox": {
    "id": "2ed84e6a-5e30-4a0e-8e2f-c97ad3ae4242",
    "address": "api-a94f...@example.com",
    "expires_at": "2026-08-01T20:00:00.000Z"
  }
}
```

## Lire les messages reçus

`GET /api/v1/mailboxes/{id}/messages?limit=50`

```bash
curl "https://votre-serveur/api/v1/mailboxes/ID/messages?limit=50" \
  -H "Authorization: Bearer VOTRE_CLE"
```

`limit` accepte 1 à 100 éléments et vaut 50 par défaut. Seules les adresses créées par l’API pour le même utilisateur sont accessibles. Les messages les plus récents arrivent en premier.

Le résultat contient l’expéditeur, le destinataire, le sujet, les corps texte et HTML, la date, la taille ainsi que les métadonnées des pièces jointes. Le contenu binaire des pièces jointes n’est pas exposé.

`body_html` est du contenu externe non fiable. Assainissez-le et affichez-le dans une iframe isolée; ne l’injectez jamais directement dans une page.

## Limites

- 20 créations par heure et par clé.
- 180 lectures par minute et par clé.
- 5 clés actives maximum par utilisateur.
- Durée d’une adresse: 10 à 1 440 minutes.
- Aucun endpoint d’envoi.

## Erreurs

| HTTP | Code | Signification |
| --- | --- | --- |
| 400 | `invalid_request` | Paramètres ou identifiant invalides |
| 401 | `unauthorized` | Clé absente, invalide, révoquée ou accès retiré |
| 404 | `mailbox_not_found` | Adresse inconnue ou appartenant à un autre utilisateur |
| 409 | `mailbox_limit_reached` | Quota atteint |
| 409 | `no_domain_available` | Aucun domaine actif |
| 410 | `mailbox_expired` | Adresse arrivée à expiration |
| 413 | `payload_too_large` | Corps de requête trop volumineux |
| 429 | `rate_limited` | Limite temporaire dépassée |

Les erreurs sont retournées en JSON, par exemple:

```json
{ "error": "unauthorized" }
```
