# Instant Vote

PWA de vote en temps réel — minimaliste, sans dépendances NPM, zéro framework.

## Architecture

```
instant-vote/
├── server.js              # Serveur HTTP Node.js (API + SSE + fichiers statiques)
├── package.json
├── data.json              # Persistance légère (créé automatiquement)
└── public/
    ├── index.html         # PWA complète (admin + vote + display)
    ├── manifest.webmanifest
    ├── sw.js              # Service Worker
    └── icon-192.png       # À fournir
    └── icon-512.png       # À fournir
```

### Principes techniques

- **Zéro dépendance NPM** : Node.js pur (module `http`, `fs`, `path`, `url`)
- **Temps réel léger** : Server-Sent Events (SSE) — unidirectionnel serveur→client, sans WebSocket
- **Stockage minimal** : JSON en mémoire + fichier `data.json` pour la persistance entre redémarrages
- **PWA** : installable sur mobile/desktop, fonctionne en mode déconnecté (pages statiques mises en cache)
- **SPA** : une seule page HTML, routing côté client via `window.location.pathname`

### Flux de données

```
Admin (POST /api/vote/start)
  → Server broadcast SSE "voteStart"
    → Display (affiche QR + question + résultats live)
    → Vote (affiche le formulaire de vote)

Votant (POST /api/vote/cast)
  → Server broadcast SSE "voteUpdate"
    → Admin (mise à jour carte)
    → Display (mise à jour temps réel)
```

## Démarrage local

```bash
node server.js
```

- Admin :   http://localhost:3000/admin (ou http://localhost:3000/)
- Display : http://localhost:3000/display
- Vote :    http://localhost:3000/vote

## Déploiement

### Option 1 — VPS (recommandé pour une installation permanente)

**Prérequis** : Node.js 18+, un nom de domaine, HTTPS (obligatoire pour PWA)

```bash
# 1. Copier les fichiers sur le serveur
scp -r instant-vote/ user@monserveur.com:/var/www/

# 2. Installer PM2 pour garder le process en vie
npm install -g pm2
pm2 start /var/www/instant-vote/server.js --name instant-vote
pm2 save
pm2 startup

# 3. Configurer Nginx comme reverse proxy
```

**Configuration Nginx :**
```nginx
server {
    listen 443 ssl;
    server_name vote.mondomaine.com;

    ssl_certificate     /etc/letsencrypt/live/vote.mondomaine.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vote.mondomaine.com/privkey.pem;

    # Buffering désactivé pour SSE
    proxy_buffering off;
    proxy_cache off;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # Timeout long pour SSE
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

```bash
# Certificat HTTPS gratuit avec Let's Encrypt
certbot --nginx -d vote.mondomaine.com
```

### Option 2 — Railway.app (déploiement cloud rapide, gratuit pour usage léger)

```bash
# Installer Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
railway domain  # Obtenir un domaine HTTPS automatique
```

La variable `PORT` est automatiquement injectée par Railway.

### Option 3 — Render.com

1. Pousser le code sur GitHub
2. Créer un "Web Service" sur render.com
3. Build command : _(vide)_
4. Start command : `node server.js`
5. Plan Free (instanciation à froid ~30s)

**Note** : Le plan gratuit de Render met le service en veille après inactivité. Pour une session de vote, préférez Railway ou un VPS.

### Option 4 — Hébergement mutualisé avec Node.js (Infomaniak, o2switch…)

Vérifier que le panel propose Node.js (version 18+) et configurer le port dans les variables d'environnement.

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT`   | `3000` | Port d'écoute du serveur |

## Sécurité — recommandations pour une utilisation en production

1. **Authentification admin** : Ajouter un middleware simple avec un token ou HTTP Basic Auth pour protéger `/admin` et les routes `/api/vote/start`, `/api/vote/end`, `/api/questions`.
   
   Exemple minimal :
   ```js
   const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';
   // Dans le serveur, avant les routes API admin :
   if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
     res.writeHead(401); return res.end('Unauthorized');
   }
   ```

2. **Rate limiting sur `/api/vote/cast`** : Limiter les votes par IP pour éviter le bourrage.
   ```js
   const castLog = new Map(); // ip -> timestamp dernier vote
   // Dans le handler /api/vote/cast :
   const ip = req.socket.remoteAddress;
   if (castLog.get(ip) === activeVote?.questionId) {
     return sendJSON(res, 429, { error: 'Déjà voté' });
   }
   castLog.set(ip, activeVote?.questionId);
   ```

3. **HTTPS obligatoire** pour les PWA (Service Worker requis).

## Icônes PWA

Fournir deux fichiers PNG dans `public/` :
- `icon-192.png` : 192×192 px
- `icon-512.png` : 512×512 px

Outil en ligne pour générer : [realfavicongenerator.net](https://realfavicongenerator.net)

## Structure des fichiers de données

`data.json` (créé automatiquement) :
```json
{
  "questions": [
    {
      "id": "1700000000000",
      "title": "Titre de la question",
      "options": ["Option A", "Option B", "Option C"],
      "createdAt": "2024-01-01T10:00:00.000Z",
      "startedAt": "2024-01-01T10:05:00.000Z",
      "endedAt": "2024-01-01T10:15:00.000Z",
      "hasResults": true
    }
  ],
  "activeVote": null,
  "votes": {
    "1700000000000": { "0": 12, "1": 8, "2": 3 }
  }
}
```

## Format d'import XLSX

Le bouton "Modèle" télécharge un fichier exemple. Format attendu :

| Titre | Option1 | Option2 | Option3 | … |
|-------|---------|---------|---------|---|
| Ma question | Oui | Non | Abstention | |

Jusqu'à 10 options par question (Option1 à Option10).
