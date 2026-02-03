# Watch Together - Chrome Extension

Extension Chrome pour regarder des vidéos de manière synchronisée sur 11+ plateformes de streaming.

## Développement

### Installation des dépendances
```bash
npm install
```

### Build en mode développement
```bash
npm run build
```

### Build en mode watch (auto-rebuild)
```bash
npm run watch
```

### Build pour la production
```bash
npm run build:prod
```

### Créer le ZIP pour le Chrome Web Store
```bash
npm run release
```

Le fichier `watch-together-v1.0.0.zip` sera créé à la racine du projet.

## Structure du projet

```
extension/
├── src/
│   ├── background/          # Service worker
│   │   └── websocket.ts     # Gestion WebSocket et sessions
│   ├── content/             # Scripts injectés dans les pages
│   │   ├── youtube.ts       # Adapter YouTube
│   │   ├── netflix.ts       # Adapter Netflix
│   │   ├── crunchyroll.ts   # Adapter Crunchyroll
│   │   ├── vimeo.ts         # Adapter Vimeo
│   │   ├── dailymotion.ts   # Adapter Dailymotion
│   │   ├── adn.ts           # Adapter ADN
│   │   ├── animesama.ts     # Adapter Anime-Sama
│   │   ├── twitch.ts        # Adapter Twitch
│   │   ├── disneyplus.ts    # Adapter Disney+
│   │   ├── primevideo.ts    # Adapter Prime Video
│   │   └── max.ts           # Adapter Max
│   ├── popup/               # Interface popup
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.ts
│   └── shared/              # Code partagé
│       ├── events.ts        # Types d'événements
│       └── adaptive-sync.ts # Algorithme de synchronisation
├── dist/                    # Fichiers compilés (généré)
├── icons/                   # Icônes de l'extension
├── manifest.json           # Manifest Chrome Extension
├── build.js                # Script de build
├── create-release.js       # Script de création du ZIP
└── package.json

```

## Plateformes supportées

1. **YouTube** - Synchronisation complète avec détection de publicités
2. **Netflix** - Synchronisation avec gestion DRM
3. **Crunchyroll** - Support des vidéos et iframes
4. **Disney+** - Gestion DRM
5. **Amazon Prime Video** - Gestion DRM
6. **Max (HBO Max)** - Gestion DRM
7. **Twitch** - Support live et VOD
8. **Vimeo** - API officielle Vimeo Player
9. **Dailymotion** - SDK officiel
10. **ADN** - HTML5 natif
11. **Anime-Sama** - HTML5 natif

## Fonctionnalités

- ✅ Synchronisation parfaite play/pause/seek
- ✅ Détection et gestion des publicités (YouTube)
- ✅ Rooms avec codes partageables
- ✅ Auto-join via liens
- ✅ Auto-déconnexion lors de la navigation
- ✅ Support multi-onglets
- ✅ Gestion des permissions utilisateurs
- ✅ Synchronisation adaptative avec correction du drift

## Configuration

### Serveur WebSocket
Le serveur WebSocket est configuré dans `src/background/websocket.ts` :

```typescript
const WS_SERVER_URL = 'ws://watch-together-backend-production.up.railway.app';
```

## Soumission au Chrome Web Store

Consulte le fichier [STORE_SUBMISSION.md](./STORE_SUBMISSION.md) pour les instructions détaillées.

### Résumé rapide :
1. `npm run release` - Crée le ZIP de production
2. Va sur https://chrome.google.com/webstore/devconsole
3. Upload le fichier `watch-together-v1.0.0.zip`
4. Remplis les informations (voir STORE_SUBMISSION.md)

## Notes techniques

### Mode Production vs Développement

**Mode Développement** (`npm run build`) :
- Source maps inclus
- Console logs actifs
- Pas de minification

**Mode Production** (`npm run build:prod`) :
- Pas de source maps
- Console logs supprimés
- Code minifié (50% de réduction)

### Gestion des publicités

YouTube : Détection via MutationObserver sur 3 critères
- Classes CSS (`ad-showing`, etc.)
- Éléments DOM overlay
- Bouton "skip ad"

### Auto-join

Les URLs partagés contiennent le paramètre `?wt=ROOM_CODE`.
Le content script détecte ce paramètre et rejoint automatiquement la room avec retry automatique.

### Auto-disconnect

L'extension détecte automatiquement quand l'utilisateur :
- Ferme un onglet sur une plateforme supportée
- Navigue vers un site non-supporté

Si aucun onglet actif ne reste sur une plateforme supportée, l'utilisateur est automatiquement déconnecté de la room.

## Troubleshooting

### "Unknown message type" error
- Vérifiez que tous les cas sont gérés dans `websocket.ts`
- Consultez les logs console pour le type de message inconnu

### La synchronisation ne fonctionne pas
- Vérifiez que le serveur WebSocket est accessible
- Ouvrez la console pour voir les logs de connexion
- Vérifiez que l'adaptateur détecte correctement la vidéo

### L'auto-join ne fonctionne pas
- Le système réessaie automatiquement 3 fois
- Vérifiez que le format du room code est valide (8 caractères alphanumériques)
- Consultez les logs pour voir les tentatives

## License

MIT License

## Contact

contact@virgiletomadon.fr
