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
| 14 | Pin basemind | Rester sur **`10cc546`** (pas le pin fork `d077002`) ; adapter le port (#23) |
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
| 27 | Modèles | Préseed pinné : NER `knowledgator/gliner-pii-edge-v1.0` (~185 Mo) + reranker `onnx-community/gte-multilingual-reranker-base` (~358 Mo) = **~543 Mo** ; embeddings via MCP `memory documents` (warmup basemind, non pinné) ; legacy gliner_small (673 Mo) non téléchargé ; reranker y compris toggle OFF (#22) |
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

## 8. Bannière onboarding « Rendre Safe » (#20)

- **Slot** : bannière workspace-open (motif `WorkspaceSwitchBanner` / `TopNoticeStack`), **pas** une étape `onboardingSteps`.
- **Déclencheur** : workspace jamais rendu safe et non skippé (clé localStorage par workspace) ; re-proposition via settings, jamais de nag.
- **États** : proposé / skippé / en cours (**indéterminé**) / actif (« Safe ✓ · N fichiers… » avec compteur) / échec (réessayer — 1er passage).
- **Copy** : « Rendre ce dossier Safe PII et cherchable ? … copie redacted dans `safe/`. **~543 Mo de modèles pinnés + embeddings** au 1er usage (quelques minutes, ~300 s par lot, reprise possible), offline ensuite. » + CTA + « Plus tard » + « En savoir plus ».
- **i18n** : `fr` à fresque depuis `en` ; ~28 clés `basemind.*` fork en mémoire ; **toute chaîne visible dans les 8 locales avant merge** ; jamais `error.message` brut.

## 9. Préseed modèles (#22)

- **Port phase-2** (après canal #23) : `basemindPreseed.ts`, `basemindDownload.ts`, `scripts/download-basemind.mjs`, manifestes sha256+size, reprise Range + `.incomplete`, rejet mismatch sha256.
- **Déclenchement** : sur clic « Rendre Safe » (pas de pull proactif), ordre : preseed → warmup embeddings (`memory documents`) → safe-sync → rescan → badge.
- **Pins** : NER edge `knowledgator/gliner-pii-edge-v1.0` rev `main` ; GTE `onnx-community/gte-multilingual-reranker-base` rev `main` ; GLINER legacy non utilisé.
- **Offline** : cache HF standard partageable ; mode `HF_HUB_OFFLINE` supporté une fois rempli.

## 10. Hors périmètre (non-goals)

- Embeddings/reranker **cloud** ; édition originel depuis `safe/` ; toute migration/lecture `.redacted/` ; modification des handlers fichiers existants ; triage content custom côté Workstation ; pre-filter extension sur le watcher ; audit reveal ; vault/rules per-agent ; champ regex dans le geste PII ; étape onboarding basemind ; progress events live (v1) ; cherry-pick de l'historique fork ; bump de pin basemind ; website source dans ce repo.

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
