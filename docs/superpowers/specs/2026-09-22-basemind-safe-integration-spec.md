# Intégration basemind via dossier `safe/` — Spec consolidée

- **Date :** 2026-09-22
- **Statut :** route validée (wayfinder map [#15](https://github.com/jamon8888/hacienda-cowork/issues/15), tickets #16–#23 clos) — prête à implémenter
- **Prérequis lu :** `docs/superpowers/specs/2026-09-09-pii-redacted-content-system-design.md`
- **Principe :** aucun fork dans `submodules/*` ; 2 coutures minimes + 1 module isolé ; code = états finaux du fork `jamon8888/interpreter-workstation`, jamais des cherry-picks séquentiels.

## 1. Objectif

Intégrer basemind à Workstation de façon simple, transparente et découplée : tout le RAG et toute l'interrogation fichiers via LLM passent par un miroir markdown redacted `<workspace>/safe/`. Destination wayfinder = **route validée, pas le code fusionné** — ce document est le contrat d'implémentation.

## 2. Faits établis (recherches #16 / #17)

- **Incrémental natif basemind** : blobs content-adressés, fast-path mtime+size, `admin rescan` avec `paths: Option<Vec<String>>` (MCP) / `rescan [PATH]` (CLI). Preuves : `submodules/basemind/src/store.rs:198-202`, `src/mcp/types.rs:778`, `src/cli/admin.rs:34-41`.
- **Redaction** : `redact_capturing_rehydration_map` (`src/extract/doc.rs:520`), stratégie TokenReplace (`[TYPE_N]`), map chiffrée en blob ; outils MCP `redact_text` + `vault` (modes encrypt/decrypt/find/forget/inspect), CLI `redact` / `vault …`. **Noms réels ≠ spec** : `search_documents` = tool `memory` mode `documents` ; `redact` → `redact_text`.
- **NER** : backend `Onnx` par défaut, `llm` opt-in via `[llm]` partagé ; embeddings/reranker locaux (pas de variante cloud). ~250 Mo GLiNER au 1er usage (smoke `tests/scan_smoke.rs:816-821`).
- **Racine workspace** : git OU `basemind.toml` ; `BASEMIND_ALLOW_ANY_ROOT=1` hatch (`src/config/root_guard.rs`).
- **Deux canaux** (à porter, #23) : CLI one-shot (boot/warmup) + MCP persistant (`serve` + socket). Tout `safe-sync` passe en MCP.
- **Vide dans ce checkout** (hacienda @ `484b206`) : `basemindManager`, `workspaceScan`, `search.ts`, `src/lib/pii`, ScanBanner/PII panel — **absents** ; locale `fr` absente (7 locales) ; aucun `basemindRescan` branché sur le watcher. Le design initial était un design forward, pas un état vérifié.
- **Watcher** : `handleWorkspaceWatchEvent` existe (`server/workspaceWatchRegistry.ts:109`), motif injectable thumbnail à copier (`:18–49`, use `:116–127`).
- **Chokepoint RAG** : `resolveStreamWorkspacePathForAgentRequest` (`server/routes/agent.ts:188–218`, consommé `:928–930`).
- **Chokepoint redact** : **n'existe pas** — à créer avant `runCodexAgentTurn` (`agent.ts:975`, payload `codexRuntime.ts:2115–2133`).
- **Préseed** : **chaîne absente** de ce repo (seul `download:qwen-asr` a des manifestes sha256). Le fork a `basemindPreseed.ts` / `basemindDownload.ts` à porter (#22).
- **Fork** : `jamon8888/interpreter-workstation`, merge-base `85056455`, 207 commits fork-only (36 merges, 6 paires dupliquées, churn rename Interpreter→Hacienda, 95 commits `fix`). **Ne jamais cherry-pick l'histogramme** — prendre les états finaux des fichiers.

## 3. Décisions verrouillées (tickets #16–#23)

| # | Sujet | Choix (ticket) |
|---|-------|----------------|
| 1 | Source de vérité | `safe/` = miroir dérivé read-only ; workspace = seule source éditable |
| 2 | Corrections PII | Extraites en règles `custom_terms`/`custom_patterns`, réappliquées à chaque passe ; jamais d'écriture vers l'originel ; règles **re-dérivées de `safe/` à chaque regen** (miroir = store, pas de fichier side-car) (#21) |
| 3 | Emplacement | `<workspace>/safe/` dans le workspace, exclu du scan et du watcher (anti-boucle) |
| 4 | Lien originel | Front-matter YAML : `original_path`, `content_hash`, `rehydration_ref`, `generated_at` ; corps = markdown redacted. Clés front-matter non traduites (snake_case machine) |
| 5 | Point de redaction | À l'extraction : index + `safe/` en tokens, map en vault (zéro PII dans les vecteurs) |
| 6 | Requête PII | Interception **avant `runCodexAgentTurn`** : provider en tokens, match local via map ; zéro clair sur le réseau (#19) |
| 7 | Réhydratation | UI-only, **clair par défaut + toggle « Show Originals »** ; pas d'audit reveal en v1 ; historique provider en tokens (#19) |
| 8 | Incrémental | Watcher → debounce **2 s trailing par workspace** (timer `unref`) → un seul `admin rescan(paths)` ; suppression → suppression md + GC ; **jamais de full scan**, **jamais de rescan sur édition safe/** (#21) |
| 9 | Découplage | Module isolé `safe-sync` (hook watcher, MCP-only) + 2 coutures (RAG sur `safe/`, intercepteur redact) ; handlers fichiers intouchés |
| 10 | Périmètre extraction | **Tous les types documents xberg extractibles** (PDF, Office, emails, OCR, markdown, texte…) ; **aucune couche de triage côté client** (#18) |
| 11 | Ajout PII manuel | Sélection Tiptap → catégorie (`NerConfig.categories`) **ou terme custom libre** → token coloré + règle ; **pas de champ regex en v1** (#19) |
| 12 | Onboarding | **Bannière workspace-open uniquement** (pas d'étape onboarding) ; opt-in explicite, coût annoncé (#20) |
| 13 | Indexation code | **Présente mais OFF par défaut**, opt-in explicite seulement ; lanes sémantiques code inactives tant que non activées (#18) |
| 14 | Pin basemind | **`v0.32.2`** (`acd7f2d`) pour le sous-module comme pour le binaire téléchargé : `redact_text {file_path}` et GLiNER2 (basemind #24/#26), défauts 8 Go, motifs téléphone internationaux/FR (basemind #27), `ner_ran` + `require_ner` et les 42 labels GLiNER2 (basemind #28) ; remplace `8b08eed`/`v0.32.1` |
| 15 | Search + reranker | Porter **`search.ts` + `rerankerPreference.ts` ensemble** (état final) (#23) |
| 16 | workspaceScan | **Réintégré au port** (#20 amende #23) : handler + IPC statut pour le compteur « N fichiers » |
| 17 | Compteur bannière | **En v1** : « Safe ✓ · N fichiers cherchables » ; clé locale dès J1 (#20) |
| 18 | Progression sync | **Indéterminée** en v1 (spinner) ; events de progress = fog conditionnel (#20/#21) |
| 19 | Erreurs rescan | Incrémentales **silencieuses** (log + retry naturel) ; état échec/réessai **uniquement sur le 1er passage** safe-sync (#21) |
| 20 | Predicate watcher | Spec (`safe/`, `.redacted/`, `.basemind/`, dirs, fichiers only) ; **pas de pre-filter par extension** — la sélection content reste à basemind (#21) |
| 21 | Activation redact | **Workspace-gated** : armé seulement après opt-in safe/ (#19) |
| 22 | Portée outbound | **Texte libre + résultats d'outils** (les deux jambe) ; pièces jointes seulement si gratuit avec le même appel, sinon différé (#19) |
| 23 | Scope PII | **Workspace-scoped** (règles + vault partagés par workspace) ; permissions fichier **par agent** inchangées, au-dessus (#19) |
| 24 | Split search | RAG/conversation → `safe/` strictement ; **exact/filename search inchangé sur les originaux** (code trouvable, jamais embed) (#18) |
| 25 | `.redacted/` | **Mort** — remplacé par `safe/` ; pas de migration, pas de lecture, pas d'affichage (#18) |
| 26 | Préseed | **Porter la chaîne fork sha256** en phase-2 après #23 ; sur clic opt-in + **resume** ; set complet (#22) |
| 27 | Modèles | Préseed pinné : NER `fastino/gliner2-privacy-filter-PII-multi` (~1,24 Go) + reranker `onnx-community/gte-multilingual-reranker-base` (~358 Mo) = **~1,6 Go** ; embeddings via MCP `memory documents` (warmup basemind, non pinné) ; legacy gliner_small (673 Mo) non téléchargé ; reranker y compris toggle OFF (#22) |
| 28 | Copy bannière | Annoncer **~543 Mo pinnés + embeddings** (pas le ~250 Mo périmé), deadline 300 s (`XBERG_MODEL_DOWNLOAD_TIMEOUT_SECS`), retry, offline une fois caché ; 8 locales avant merge (#22/#20) |
| 29 | Locale `fr` | **Créer à fresque depuis `en.json` courant** ; fork `fr.json` = mémoire de traduction seulement (snapshot périmé 1829 l. vs en 2294 l.) (#20) |
| 30 | Bugfix séparé | `233b2f8` (AppUpdateDialog boucle infinie) = **commit à part**, session au plus, jamais mélangé au port (#23) |

## 4. Port phase-1 — canal MCP/CLI (#23)

**Méthode :** états finaux depuis `iwfork/main` (clone `/tmp/opencode/iw-fork` ou remote `iwfork`), **jamais** cherry-picks séquentiels.

### Fichiers à porter

1. `server/utils/basemindManager.ts` — daemon socket, resolveur binaire, MCP register/unregister/status
2. `server/utils/hubCache.ts` — readiness HF multi-root
3. `server/handlers/cpuFeatures.ts`
4. `server/handlers/search.ts` — `basemindSearchCode` validé
5. `server/handlers/rerankerPreference.ts` — depend dynamique de search.ts final
6. `server/tools/builtin-tools/workstation/workspaceSearchTool.ts` + 2 lignes de registration dans `workstation/index.ts`
7. `server/handlers/workspaceScan.ts` — **réintégré (#20)** + namespace IPC statut
8. `server/routes/ipc.ts` — namespaces additifs `basemind` + `search` (+ `workspaceScan`) ; `src/ipc.ts` surface statut
9. `scripts/download-basemind.mjs` + `package.json` `download:basemind` — **phase-2 avec #22** (peut suivre immédiatement le canal)

### Wiring (additif, main propre)

- Registre watcher : hook `safe-sync` au motif thumbnail, `server/workspaceWatchRegistry.ts:116–127` (type + loader lazy + var injectable `:18–49`, test setter `:288–294`).
- RAG : root → `<workspace>/safe/` via `resolveStreamWorkspacePathForAgentRequest` / `runWithWorkspaceOverride` (`server/utils/workspace.ts:34–43`).
- Redact : interceptor **avant** `runCodexAgentTurn` (`agent.ts:975`).

### Jamais pick

36 commits merge ; paires dupliquées (`46fa7b7`+`b210de3`, `4d3fe33`+`52bd67c`, `e535910`+`d65f680`, `0f0fe97`+`86efee9`, `9f5d55e`+`58b2123`, `e74acff`+`3f3ef18`) ; série rename dont `ba3b82d` (mega-commit PII+rename, non pickable) ; repair merges (`7cdb973`, `9dbf6f6`, `b89356c`) ; sweep `7d3c2bc` ; fixes de tests skip (`27300e9`, `0e3a805`, `e0ec0bd`, `6b0db0f`).

### Séparé

- `233b2f8` — fix `AppUpdateDialog.tsx:132` (boucle « Maximum update depth ») — **commit isolé**.

## 5. Composant `safe-sync` (isolé, MCP-only)

- **Cycle** : event originel → debounce 2 s → `extract` → `redact` (TokenReplace + `custom_terms` dérivés de `safe/`) → écrit `safe/*.md` → `vault encrypt` → `admin rescan(paths=[fichier])`.
- **Nommage du miroir** : nom complet de l'original + `.md` (`rapport.pdf` → `safe/rapport.pdf.md`), pour que deux originaux ne différant que par l'extension ne s'écrasent jamais. Le remplissage initial applique les mêmes exclusions que le watcher (`.git`, `node_modules`, dotfiles…).
- **Périmètre v1** : types documents xberg ; fichiers code = recherche exacte existante uniquement, lane sémantique OFF par défaut (opt-in #18).
- **Garde anti-boucle** : ignore `safe/`, `.redacted/`, `.basemind/` + dirs ; prédicat pur fichiers `add`/`change`/`unlink` ; pas de filtre extension (#21).
- **Coalescence** : 2 s par workspace ; fire-and-forget `catch` — un échec ne casse jamais le watch ; `unref` ; clear à la libération.
- **Erreurs** : incrémentales silencieuses ; failed/retry uniquement 1er passage (#21).
- **Édition safe/** : diff md → règles → rewrite ; **pas de rescan** (anti-loop acceptation 4) ; règles re-dérivées du miroir (#21).
- **Point d'insertion** : `handleWorkspaceWatchEvent`, entonnoir unique ; hook injectable (motif thumbnails).

## 6. Couture A — RAG scopé sur `safe/`

- Conversation / `search_documents` / outils : `root = <workspace>/safe/`, jamais les originaux.
- Lane RAG documents uniquement (sémantique + full-text + NER) ; lane code OFF par défaut, opt-in explicite (#13).
- Exact/filename search (`useFileSearch`, ripgrep) : **inchangé**, originaux (#24).
- `.redacted/` : mort (#25).

## 7. Couture B — Redact-before-provider + réhydratation + édition

- **Armement** : workspace-gated (opt-in #12/#21-activation).
- **Aller** : texte libre + résultats d'outils → `redact` (config + corrections `safe/`) → provider en tokens ; interception pre-`runCodexAgentTurn` (#6/#22).
- **Retour/affichage** : decrypt vault local au rendu → **clair par défaut**, toggle « Show Originals » ; historique provider en tokens (#7).
- **Éditeur `safe/`** : `MarkdownViewer` + `PiiLabelExtension` (view : tokens colorés ; compose : regex instant + NER au submit) ; geste catégorie ou terme custom (#11) ; save → md redacted + règle, sans rescan.
- **Scope** : rules/vault workspace-scoped ; permissions par agent inchangées (#23).
- **Termes personnalisés** (geste #11) : chiffrés dans le coffre du workspace (`vaults/<segment>/custom-terms.enc`), jamais écrits dans le workspace ; passés à chaque appel `redact_text` (qui ne lit pas `basemind.toml`) et détectés localement en littéral, insensible à la casse, même NER indisponible.
- **Couverture de l'aller** (workspace armé) : message + prompt système du chat, messages envoyés en cours de tâche (steer), tâches headless (`/tasks`, CLI, sous-agents `run_agent`), objectifs de conversation, résultats des outils passant par `ToolManager`. Les pièces jointes (images) ne sont jamais analysées : **tout envoi avec pièce jointe est refusé** dans un workspace armé.
- **Limites connues (v1)** — la promesse est « le texte envoyé par l'app est pseudonymisé », pas « le provider ne voit jamais d'original » :
  - ~~les outils natifs du runtime (shell, lecture de fichiers Codex) ne passent pas par `ToolManager` : un agent qui lit un original hors `safe/` l'envoie en clair~~ — fermé (2026-10-02) par le confinement : dans un workspace Safe, le `cwd` OIX devient `safe/`, le profil de permissions rend les originaux illisibles (lecture `safe/`, écriture `safe/_drafts/` seulement), `AGENTS.md` n'est plus chargé (`project_doc_max_bytes = 0`) et aucune escalade n'est approuvée. Vérifié sur Linux (bubblewrap) ; macOS et Windows restent à vérifier ;
  - la voix n'est pas pseudonymisée ;
  - un objectif de conversation pseudonymisé s'affiche sous forme de jetons ;
  - les miroirs créés avec l'ancien nommage (`safe/rapport.md`) ne sont pas supprimés automatiquement.

## 7 bis. Fiche dossier (`DOSSIER.md`)

Un fichier `DOSSIER.md` à la racine du workspace porte le contexte du dossier (parties, juridiction, dates clés, consignes). Comme tout fichier, `safe-sync` le miroite en `safe/DOSSIER.md.md` ; **seul ce miroir** est injecté dans le prompt, sous `## Dossier`, entre le pack métier et les instructions personnalisées. L'original n'est jamais lu : il est seulement `stat`é pour savoir si son miroir est à jour. Miroir absent ou plus ancien que l'original (la synchro a ~2 s de retard) : la section dit que la fiche n'est pas prête et n'en révèle rien. Plafond 8 000 caractères ; au-delà, le début seul est montré et le prompt indique où lire la suite.

## 7 ter. Surfaces qui restent actives en Safe

Safe pseudonymise le texte et confine la lecture, mais quatre canaux transportent un contenu que l'app ne sait pas pseudonymiser. L'utilisateur choisit lesquels restent actifs dans les dossiers Safe (Réglages > Général > Confidentialité) ; le réglage `safeSurfaces` n'est modifiable ni par l'agent ni par un chemin `settings_set` détourné.

| Surface | Défaut | Quand elle est coupée, dans un dossier Safe |
|---|---|---|
| `voice` | **coupée** | la session vocale temps réel (`advanced-voice-controller`, `createCall`) est refusée avec un message dans la langue de l'utilisateur ; la dictée locale n'est pas concernée (son texte passe par la pseudonymisation) |
| `computerUse` | active | les serveurs `builtin-cua-driver` et `builtin-interpreter-overlay` disparaissent pour le modèle ; la politique d'accès Computer Use passe en refus (inspecter, contrôler, règles par app comprises) ; la section « contrôle du bureau » et le skill `computer-use` quittent le prompt |
| `browserControl` | active | la politique d'accès au navigateur passe en refus pour lire, écrire et agir, au niveau du relais (donc aussi pour Playwright dans `js_repl`), et grants et règles par profil ne la rouvrent pas ; le skill `browser-control` quitte le prompt |
| `network` | active | le bac à sable n'a plus de réseau ; `builtin-google` (recherche web) disparaît ; le prompt ne parle plus de réseau |

Choix de conception :
- **Allumer demande une confirmation** (`confirmed: true`, posé par la seule boîte de dialogue) ; éteindre non.
- **Chaque changement est écrit d'abord dans le journal d'audit chaîné** (`safe_surface_changed`, surface et nouvel état, jamais le contenu) : pas de trace, pas de changement.
- Le réglage s'applique là où la politique est appliquée, jamais à ce que l'écran des réglages affiche ou enregistre : la politique du navigateur de l'utilisateur reste la sienne.

Limites connues : un serveur MCP ajouté par l'utilisateur n'est pas coupé avec `network` ; les onglets du navigateur intégré à l'app ne sont pas ceux de `browserControl` ; avec plusieurs fenêtres sur des dossiers différents, le relais du navigateur (global) suit le dossier courant.

## 7 quater. Travailler sur les originaux avec un modèle local

Avec un modèle qui tourne sur la machine, rien ne part chez un fournisseur. L'utilisateur peut alors choisir (`safeLocalBypass`, Réglages > Général > Confidentialité) que les dossiers Safe se travaillent sur les originaux, sans pseudonymisation. La garantie change : non plus « pseudonymisé », mais « rien ne quitte la machine ».

Pourquoi les originaux et pas les copies : sans pseudonymisation du message, l'agent lirait `[PERSON_0]` dans les copies pendant que l'utilisateur écrit le vrai nom ; le registre du workspace ne ferait plus le lien.

Une conversation passe en « local uniquement » quand toutes ces conditions tiennent (`server/services/localModelBypass.ts`, vérifié là où l'app ouvre le fil dans le runtime, `app-server-client`) :
- le dossier est Safe et le réglage est actif ;
- le point d'accès envoyé au runtime (`model_providers[provider].base_url`, après résolution du profil) est en loopback strict : `localhost`, `127.0.0.0/8`, `::1`. `0.0.0.0`, une adresse du réseau local, un nom qui ressemble à `localhost` et le port du serveur de l'app (il héberge le proxy Groq) sont refusés, comme les fournisseurs hébergés (`interpreter`, `openai`) et toute connexion par compte ;
- si la garde anti-injection est active, son modèle est local aussi (elle lit les résultats d'outils) ;
- les surfaces `network`, `browserControl` et `computerUse` sont coupées. Activer le réglage les coupe (chaque coupure est auditée) ; en rallumer une rend le réglage inopérant, et l'écran le dit.

Ce qui change pour une telle conversation :
- message, prompt système et instructions personnalisées partent sans pseudonymisation ; les résultats d'outils aussi ;
- le runtime lit et écrit dans le dossier (lecture limitée au dossier, aux skills et au runtime), sans réseau ; `AGENTS.md` est chargé ;
- le prompt remplace la section Safe par une section « Local-only workspace » ; la fiche dossier vient de `DOSSIER.md` lui-même ;
- les approbations de fichiers et d'images suivent le chemin normal ; les commandes ne sont toujours jamais escaladées (elles tourneraient hors du bac à sable, réseau compris).

Une conversation menée ainsi est marquée pour toujours (`server/services/localOnlyThreads.ts`, liste sur disque, `0600`), forks compris. Rouverte sur un autre modèle, elle reste confinée et son tour suivant est refusé, avec un message dans la langue de l'utilisateur : son historique contient des valeurs réelles.

Audit, sans contenu : `local_bypass_enabled`, `local_bypass_disabled`, `local_bypass_used` (première fois par conversation, identifiant haché), `local_bypass_refused`.

Limites connues :
- les outils fichiers de Workstation (recherche du workspace comprise) restent sur les copies, faute de savoir de quelle conversation ils viennent ; l'agent lit les originaux en shell ou en Python ;
- les sous-agents et tâches de fond pseudonymisent toujours ce qu'on leur envoie ;
- un serveur local qui relaie vers un service en ligne passe la vérification : c'est la responsabilité de l'utilisateur, et l'écran le dit.

## 8. Bannière onboarding « Rendre Safe » (#20)

- **Slot** : bannière workspace-open (motif `WorkspaceSwitchBanner` / `TopNoticeStack`), **pas** une étape `onboardingSteps`.
- **Déclencheur** : workspace jamais rendu safe et non skippé (clé localStorage par workspace) ; re-proposition via settings, jamais de nag.
- **États** : proposé / skippé / en cours (**indéterminé**) / actif (« Safe ✓ · N fichiers… » avec compteur) / échec (réessayer — 1er passage).
- **Copy** : « Rendre ce dossier Safe PII et cherchable ? … copie redacted dans `safe/`. **~543 Mo de modèles pinnés + embeddings** au 1er usage (quelques minutes, ~300 s par lot, reprise possible), offline ensuite. » + CTA + « Plus tard » + « En savoir plus ».
- **i18n** : `fr` à fresque depuis `en` ; ~28 clés `basemind.*` fork en mémoire ; **toute chaîne visible dans les 8 locales avant merge** ; jamais `error.message` brut.

## 9. Préseed modèles (#22)

- **Port phase-2** (après canal #23) : `basemindPreseed.ts`, `basemindDownload.ts`, `scripts/download-basemind.mjs`, manifestes sha256+size, reprise Range + `.incomplete`, rejet mismatch sha256.
- **Déclenchement** : sur clic « Rendre Safe » (pas de pull proactif), ordre : preseed → warmup embeddings (`memory documents`) → safe-sync → rescan → badge.
- **Pins** : NER `fastino/gliner2-privacy-filter-PII-multi` rev `36126f6` ; GTE `onnx-community/gte-multilingual-reranker-base` rev `main` ; GLINER legacy non utilisé.
- **Offline** : cache HF standard partageable ; mode `HF_HUB_OFFLINE` supporté une fois rempli.

## 10. Hors périmètre (non-goals)

- Embeddings/reranker **cloud** ; édition originel depuis `safe/` ; toute migration/lecture `.redacted/` ; modification des handlers fichiers existants ; triage content custom côté Workstation ; pre-filter extension sur le watcher ; audit reveal ; vault/rules per-agent ; champ regex dans le geste PII ; étape onboarding basemind ; progress events live (v1) ; cherry-pick de l'historique fork ; tout bump de pin basemind au-delà de `v0.32.2` ; website source dans ce repo.

## 11. Critères d'acceptation

1. `.doc` modifié → seul son md régénéré, seul ce fichier repasse la pipeline (`updated=1`, `skipped_unchanged>0` sur corpus ≥ 2 fichiers) ; aucun modèle d'embedding **code** téléchargé.
2. PII ajoutée à la main → survit au rescan suivant (règles re-dérivées).
3. « jean dupond » → provider en token, match réel local, clair affiché.
4. Édition de `safe/` → **aucun rescan** (pas de boucle).
5. Daemon coupé / workspace non indexé → dégradé silencieux (exact local seul, pas d'erreur ; banner failed seulement au 1er passage).
6. Code-index config présente, **OFF** par défaut ; exact search code toujours fonctionnel.
7. Bannière : opt-in explicite, compteur N fichiers, copy ~543 Mo + offline ; pas de pull avant le clic.
8. `pnpm typecheck + test:unit + test:vitest` verts, dont tests prédicat rescan + hook injecté.
9. Toute chaîne visible dans les **8 locales** avant merge.

## 12. Ordre de livraison

1. **#23** — port canal (fichiers §4) + wiring additif + fix isolé `233b2f8` — `pnpm run precommit`
2. **#22** — port préseed + script `download:basemind`
3. **#20** — bannière + `fr` + clés `basemind.*` (8 locales)
4. **#21** — hook `safe-sync` (déjà wiré au watcher dès 1 si souhaité, logique incrémentale)
5. **#19** — interceptor redact + vault + éditeur PII
6. **#18** — couture RAG root `safe/` + opt-in config code

Chaque étape : `pnpm run precommit` ; e2e Electron selon `docs/agent-testing.md` quand la plateforme le permet.
