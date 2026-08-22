# Composer selects — padronização e polish

Lane: composer selects (worktree `composer-bench`). Bench files intocados.

## Inventário (arquivo → tipo decidido)

| Select | Arquivo | Tipo | Estado |
| --- | --- | --- | --- |
| Model picker | `ui/src/pages/chat/components/chat-model-picker.ts` + `chat-model-picker-options.ts` | single-select (check à direita + wash) | tocado (CSS) |
| Reasoning/effort | `ui/src/pages/chat/components/chat-effort-picker.ts` | single-select via slider; stop único usa check | tocado (CSS via família compartilhada) |
| Fast mode | idem (dentro do effort menu) | toggle (`role="switch"`) — correto | inalterado |
| Permission/guardian | `ui/src/pages/chat/components/chat-permission-picker.ts` | single-select (`menuitemradio` + check) | tocado (CSS) |
| Plus (+) menu | `ui/src/pages/chat/components/chat-composer-plus-menu.ts` | comandos + toggles | tocado (TS + CSS) |
| — Web search | idem | **corrigido**: era `wa-dropdown-item type="checkbox"` (check à esquerda), virou toggle `wa-switch` igual a skills/connectors — é on/off binário, não escolha entre opções | tocado |
| — Skills/Connectors/Tools | idem | toggles (`wa-switch`) — correto | inalterado |
| Attach menu (camera/photo/file) | `ui/src/pages/chat/components/chat-attachments.ts` | comandos (sem estado) | tocado (CSS) |
| Microphone device picker | `ui/src/pages/chat/components/chat-composer-controls.ts` | single-select (`menuitemradio` + check) | tocado (CSS) |
| Hold-to-dictate | idem | toggle (`role="switch"`) — correto | inalterado |
| Context-usage ring popover | `chat-composer-context.ts` | info-only, sem seleção | inalterado |
| Slash menu / Skill menu | `chat-composer-slash-menu.ts` / `chat-composer-skill-menu.ts` | autocomplete listbox (highlight ativo, não checked) | inalterado — família distinta por semântica |
| /new composer | `ui/src/pages/new-session/composer.ts` | reusa os pickers acima | herda tudo |

## Tokens escolhidos (`ui/src/styles/chat/layout.css`, bloco `--chat-composer-*`)

- `--chat-composer-menu-row-height: 40px` — antes: 40/44/36 conforme o menu.
- `--chat-composer-menu-row-padding: 6px 9px` — antes: `6px 10px`, `6px 9px`, `3px 7px`.
- `--chat-composer-menu-row-gap: 8px` — antes: 10/8/7.
- `--chat-composer-menu-row-radius: calc(10px * var(--openclaw-corner-radius-scale))` — antes: `--radius-sm`, `--radius-md`, `calc(10px*…)`.
- `--chat-composer-menu-icon: 16px` — ícones de row; muted por padrão (já era); permission usava 18px.
- `--chat-composer-menu-selected: color-mix(in srgb, var(--text) 8%, transparent)` — antes: 7%/8%/9% com receitas diferentes.

## Padrão de checked/selected

Único tratamento: **check accent à direita + fundo sutil** (`--chat-composer-menu-selected`) para single-selects; **switch** para binários. Check = caixa 16px com glifo 14px (`.chat-controls__inline-select-check` alinhado ao `.chat-talk-input-picker__check`).

## O que mudou

- `layout.css`: rows de model/permission/mic/attach/capability nos tokens acima; selected wash unificado; check 16/14; ícone da permission 18→16; permission rows 44→40; attach/capability rows 36→40 e `3px 7px`→token; removida regra morta `:has([slot="icon"]) { padding-inline-start: 7px }` (igual ao padding base); gap das model rows 7→8 alinhando com o provider heading (comentário do stem atualizado); `inline-select-section-label` virou variante inline do popover-title (type igual, padding 0 — o locked-model row é quem espaça); mic trigger `:focus-visible` de `outline 2px` para `box-shadow: var(--focus-ring)` (mesmo ring dos outros triggers); root do plus menu 184→208px para "Web search" + switch caberem em uma linha.
- `chat-composer-plus-menu.ts`: `renderCapabilityToggleRow` ganhou `icon?`; Web search deixou de ser checkbox e virou toggle row com globe + `wa-switch`.

## Hover vs focus / teclado

- Menus abertos por mouse: nenhum ring (regras `data-chat-pointer-opened-picker` / `data-chat-pointer-restored-focus` pré-existentes cobrem; hover = `--bg-hover`).
- Teclado: setas navegam (verificado no plus menu — ring visível só via `:focus-visible`), Enter seleciona, Esc fecha e devolve foco ao textarea (verificado: `document.activeElement` = TEXTAREA após Esc).

## Verificação

- Visual em `http://127.0.0.1:5230/chat?bench=default` via Playwright, dark e light: model, effort, permission, attach e capability menus (screenshots em `/tmp/herdr/shot-*.png`, todos inspecionados).
- `stylelint` no `layout.css`: mesmos 3 erros pré-existentes do HEAD (hex `#fff` ×2, duplicate selector) — nenhum novo.
- `tsgo:ui`: nenhum erro nos arquivos tocados (erros pré-existentes do checkpoint da outra lane em `chat-pane-session-controls.ts` etc. permanecem).
- `chat-view.test.ts`: 241 pass / 16 fail — idêntico com e sem a mudança (falhas pré-existentes no checkpoint).

## Follow-up: voz de label unificada (attach/capability vs permission)

- Causa da diferença apontada em review: `wa-dropdown-item::part(icon)` tem 24px intrínsecos (SVG 16px centrado → gap visual maior) e labels 12px/400 `--text` vs 13px/600 `--text-strong` do permission.
- Fix (`layout.css`): `::part(icon)` forçado a 16px nos attach/capability items; `::part(label)` = 13px/600 `--text-strong`; notes voltam a 11px/400 muted; mic device labels e model option titles alinhados ao mesmo 13px/600.
- Verificado visualmente (dark) em :5230 — attach/capability e permission agora com a mesma tipografia e mesmo trilho de ícone.

## Voice mode (dictation) refactor

- Referências: barra estilo "Listening" (Cancel ✕ à esquerda, waveform larga, ✓ à direita) + luz circulando a borda.
- Cor: dictation migrou de `--danger` para `--accent` (red brand) — borda orbitante (`chat-dictation-edge-orbit`, mantida), tint da borda, barras da wave e ✓ confirm (accent sólido, hover `--accent-hover`).
- Wave: `openclaw-microphone-activity` ganhou atributo `bars` (perfil senoidal simétrico); default 7 intacto (e2e do Talk). Dictation usa 36 barras em strip full-width acima do editor; partial transcript centralizado e ellipsized abaixo.
- Barra de captura: footer vira Cancel (✕ + "Cancel", pill neutra — mesmo elemento do mic, preservando pointer capture do hold) · label central `role="status"` (Starting…/Recording m:ss/Finishing…) · ✓ accent à direita (insere). Elementos inúteis já ocultos (lead/meta/controls/mic-picker), agora com actions esticada em `space-between`.
- i18n: `+discardDictation` ("Cancel dictation"), `-dictationReleaseToInsert` (sem usos); baseline+verify ok.
- Limpeza: CSS morto `chat-send-btn__dictation-time` e `agent-chat__dictation-copy` removidos.
- Verificação: DOM do estado dictating injetado no bench (:5230) — screenshots dark/light inspecionados (`/tmp/herdr/dict-*.png`); vitest dictation/composer suites: mesmas 5 falhas pré-existentes do checkpoint, 72 pass; tsgo:ui sem erros nos arquivos tocados; stylelint só com os 3 erros pré-existentes.

## Voice mode v2 (iteração)

- Borda: sem tint no frame; só o cometa accent (rastro longo atrás, cabeça brilhante, escuro à frente) com `corner-shape: superellipse(1.5)` no ::after.
- Wave: modo `scroll` no `openclaw-microphone-activity` — ring buffer de níveis, 48 barras finas, história correndo direita→esquerda (waveform streamando).
- Texto: partial do ditado streama direto no textarea (preview via `insertComposerDictation` na seleção capturada); placeholder oculto no modo; commit real no stop/release.
- Ações: **stop** (mesmo elemento do mic; commita o texto no draft) + **send** (commita e envia via `finishActive().then(onSend)`); sem descarte por botão — Esc é o único discard. Status vira sr-only. `finishActive` agora retorna Promise.
- i18n: `dictationStop` no lugar de `discardDictation`; `insertDictation` removido (sem usos).
- Bench: novo eixo `dictate` (off/connecting/recording/finalizing) — stub de controller semeado em `getChatComposerState("composer-bench").dictation` (marcado `benchStub`), níveis animados + partial roteirizado; linha "Dictation" no painel (`scripts/control-ui-mock-dev.ts` — requer restart do mock server para o botão aparecer; via URL `?bench={"dictate":"recording"}` já funciona).
- Verificado em :5230 via URL param: screenshots inspecionados (wave rolando, texto streamando, stop/send, borda). tsgo pulado a pedido (fase de iteração).
