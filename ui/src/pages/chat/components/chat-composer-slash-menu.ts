import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons, type IconName } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  SLASH_COMMANDS,
  getSlashCommandCategoryLabel,
  getSlashCommandCompletions,
  getSlashCommandDescription,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { resolveThinkingCommandArgOptionsForSession } from "../../../lib/chat/thinking.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { paneDomId, syncComposerMenuScroll } from "./chat-composer-dom.ts";
import { commitComposerDraft, getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function resetSlashMenuState(state: ChatComposerState): void {
  state.slashMenuMode = "command";
  state.slashMenuCommand = null;
  state.slashMenuArgItems = [];
  state.slashMenuItems = [];
}

function hasVisibleSlashMenuState(state: ChatComposerState): boolean {
  return (
    state.slashMenuOpen ||
    state.slashMenuMode !== "command" ||
    state.slashMenuCommand !== null ||
    state.slashMenuArgItems.length > 0 ||
    state.slashMenuItems.length > 0
  );
}

function closeSlashMenuIfNeeded(state: ChatComposerState, requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState(state)) {
    return;
  }
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

function resolveSlashCommandArgOptions(
  command: SlashCommandDef,
  props: ChatComposerProps,
): string[] {
  if (command.key !== "think") {
    return command.argOptions ?? [];
  }
  if (props.modelSwitching) {
    return [];
  }
  const session = props.sessions?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, props.sessionKey),
  );
  return resolveThinkingCommandArgOptionsForSession(
    session,
    props.sessions?.defaults,
    props.modelCatalog,
  );
}

function requestSlashCommandRefresh(
  value: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  if (!props.onSlashIntent || state.slashCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  state.slashCommandRefreshPending = true;
  void Promise.resolve(refresh).finally(() => {
    state.slashCommandRefreshPending = false;
    const nextValue = getCurrentValue?.() ?? props.getDraft?.() ?? value;
    if (!nextValue.startsWith("/")) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    updateSlashMenu(nextValue, requestUpdate, props, { skipSlashIntent: true });
  });
}

export function updateSlashMenu(
  value: string,
  requestUpdate: () => void,
  props: ChatComposerProps,
  opts: { skipSlashIntent?: boolean } = {},
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  const argMatch = value.match(/^\/(\S+)\s(.*)$/);
  if (argMatch) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const cmdName = argMatch[1]?.toLowerCase();
    const argFilter = argMatch[2]?.toLowerCase();
    if (cmdName === undefined || argFilter === undefined) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    const cmd = SLASH_COMMANDS.find((entry) => entry.name === cmdName);
    const argOptions = cmd ? resolveSlashCommandArgOptions(cmd, props) : [];
    if (cmd && argOptions.length > 0) {
      const filtered = argFilter
        ? argOptions.filter((arg) => arg.toLowerCase().startsWith(argFilter))
        : argOptions;
      if (filtered.length > 0) {
        state.slashMenuMode = "args";
        state.slashMenuCommand = cmd;
        state.slashMenuArgItems = filtered;
        state.slashMenuOpen = true;
        state.slashMenuIndex = 0;
        state.slashMenuItems = [];
        requestUpdate();
        return;
      }
    }
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }

  const match = value.match(/^\/(\S*)$/);
  if (match) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const items = getSlashCommandCompletions(match[1] ?? "", { showAll: true });
    state.slashMenuItems = [
      ...items.filter((command) => command.source !== "skill"),
      ...items.filter((command) => command.source === "skill"),
    ];
    state.slashMenuOpen = items.length > 0;
    state.slashMenuIndex = 0;
    state.slashMenuMode = "command";
    state.slashMenuCommand = null;
    state.slashMenuArgItems = [];
  } else {
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }
  requestUpdate();
}

export function selectSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  const argOptions = resolveSlashCommandArgOptions(cmd, props);
  if (argOptions.length > 0) {
    commitComposerDraft(props, `/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }

  if (cmd.executeLocal && !cmd.args) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    commitComposerDraft(props, `/${cmd.name}`);
    props.onSend();
  } else {
    commitComposerDraft(props, `/${cmd.name} `);
    closeSlashMenuIfNeeded(state, requestUpdate);
  }
}

export function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  const state = getChatComposerState(props.paneId);
  const argOptions = resolveSlashCommandArgOptions(cmd, props);
  if (argOptions.length > 0) {
    commitComposerDraft(props, `/${cmd.name} `);
    state.slashMenuMode = "args";
    state.slashMenuCommand = cmd;
    state.slashMenuArgItems = argOptions;
    state.slashMenuOpen = true;
    state.slashMenuIndex = 0;
    state.slashMenuItems = [];
    requestUpdate();
    return;
  }
  commitComposerDraft(props, cmd.args ? `/${cmd.name} ` : `/${cmd.name}`);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

export function selectSlashArg(
  arg: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  run: boolean,
) {
  const state = getChatComposerState(props.paneId);
  const cmdName = state.slashMenuCommand?.name ?? "";
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  commitComposerDraft(props, `/${cmdName} ${arg}`);
  if (run) {
    props.onSend();
  }
  requestUpdate();
}

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

function syncComposerMenuScrollEvent(event: Event): void {
  syncComposerMenuScroll(event.currentTarget instanceof Element ? event.currentTarget : undefined);
}
function getSlashCommandOptionId(paneId: string, cmd: SlashCommandDef): string {
  return paneDomId(paneId, `slash-option-command-${slashOptionIdSegment(cmd.name)}`);
}

function getSlashArgOptionId(paneId: string, commandName: string, arg: string): string {
  return paneDomId(
    paneId,
    `slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`,
  );
}

export function isSlashMenuVisible(state: ChatComposerState): boolean {
  if (!state.slashMenuOpen) {
    return false;
  }
  if (state.slashMenuMode === "args") {
    return Boolean(state.slashMenuCommand && state.slashMenuArgItems.length > 0);
  }
  return state.slashMenuItems.length > 0;
}

export function getActiveSlashMenuOptionId(
  state: ChatComposerState,
  paneId: string,
): string | null {
  if (!isSlashMenuVisible(state)) {
    return null;
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? getSlashArgOptionId(paneId, commandName, arg) : null;
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(paneId, cmd) : null;
}

export function getActiveSlashMenuOptionLabel(state: ChatComposerState): string {
  if (!isSlashMenuVisible(state)) {
    return "";
  }
  if (state.slashMenuMode === "args") {
    const commandName = state.slashMenuCommand?.name;
    const arg = state.slashMenuArgItems[state.slashMenuIndex];
    return commandName && arg ? `/${commandName} ${arg}` : "";
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  if (!cmd) {
    return "";
  }
  const command = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  return `${command} ${getSlashCommandDescription(cmd)}`;
}

function renderSlashIcon(name: string) {
  return icons[name as IconName] ?? icons.terminal;
}

function renderMatchedName(name: string, query: string): TemplateResult {
  const matchLength = name.toLowerCase().startsWith(query.toLowerCase()) ? query.length : 0;
  return matchLength === 0
    ? html`${name}`
    : html`<mark>${name.slice(0, matchLength)}</mark>${name.slice(matchLength)}`;
}

function renderSlashCommandOption(params: {
  cmd: SlashCommandDef;
  index: number;
  query: string;
  requestUpdate: () => void;
  props: ChatComposerProps;
  state: ChatComposerState;
}): TemplateResult {
  const { cmd, index, query, requestUpdate, props, state } = params;
  return html`
    <div
      id=${getSlashCommandOptionId(props.paneId, cmd)}
      class="slash-menu-item ${index === state.slashMenuIndex ? "slash-menu-item--active" : ""}"
      role="option"
      aria-selected=${index === state.slashMenuIndex}
      @mousedown=${(event: MouseEvent) => event.preventDefault()}
      @click=${() => selectSlashCommand(cmd, props, requestUpdate)}
      @mouseenter=${() => {
        state.slashMenuIndex = index;
        requestUpdate();
      }}
    >
      <span class="slash-menu-icon"
        >${cmd.source === "skill"
          ? icons.pencilSparkles
          : cmd.icon
            ? renderSlashIcon(cmd.icon)
            : icons.terminal}</span
      >
      <span class="slash-menu-copy">
        <span class="slash-menu-name"
          >/${renderMatchedName(cmd.name, query)}${cmd.args
            ? html`<span class="slash-menu-args"> ${cmd.args}</span>`
            : nothing}</span
        >
        <span class="slash-menu-desc">${getSlashCommandDescription(cmd)}</span>
      </span>
    </div>
  `;
}

export function renderSlashMenu(
  requestUpdate: () => void,
  props: ChatComposerProps,
  draft: string,
): TemplateResult | typeof nothing {
  const state = getChatComposerState(props.paneId);
  const listboxId = paneDomId(props.paneId, "slash-menu-listbox");
  if (!state.slashMenuOpen) {
    return nothing;
  }

  if (
    state.slashMenuMode === "args" &&
    state.slashMenuCommand &&
    state.slashMenuArgItems.length > 0
  ) {
    return html`
      <div
        id=${listboxId}
        class="slash-menu"
        role="listbox"
        aria-label=${t("chat.commands.arguments")}
      >
        <div
          class="slash-menu__scroll"
          ${ref(syncComposerMenuScroll)}
          @scroll=${syncComposerMenuScrollEvent}
        >
          <div class="slash-menu-group">
            <div class="slash-menu-group__label">
              /${state.slashMenuCommand.name} ${getSlashCommandDescription(state.slashMenuCommand)}
            </div>
            ${state.slashMenuArgItems.map(
              (arg, i) => html`
                <div
                  id=${getSlashArgOptionId(props.paneId, state.slashMenuCommand?.name ?? "", arg)}
                  class="slash-menu-item ${i === state.slashMenuIndex
                    ? "slash-menu-item--active"
                    : ""}"
                  role="option"
                  aria-selected=${i === state.slashMenuIndex}
                  @click=${() => selectSlashArg(arg, props, requestUpdate, true)}
                  @mouseenter=${() => {
                    state.slashMenuIndex = i;
                    requestUpdate();
                  }}
                >
                  <span class="slash-menu-icon"
                    >${state.slashMenuCommand?.icon
                      ? renderSlashIcon(state.slashMenuCommand.icon)
                      : icons.terminal}</span
                  >
                  <span class="slash-menu-copy">
                    <span class="slash-menu-name">${arg}</span>
                    <span class="slash-menu-desc">/${state.slashMenuCommand?.name} ${arg}</span>
                  </span>
                </div>
              `,
            )}
          </div>
        </div>
      </div>
    `;
  }

  if (state.slashMenuItems.length === 0) {
    return nothing;
  }

  const query = draft.slice(1);
  const commands = state.slashMenuItems.filter((command) => command.source !== "skill");
  const skills = state.slashMenuItems.filter((command) => command.source === "skill");
  const groups: Array<[SlashCommandCategory, Array<{ command: SlashCommandDef; index: number }>]> =
    [];
  for (const [index, command] of commands.entries()) {
    const category = command.category ?? "session";
    const group =
      draft === "/" ? groups.find(([groupCategory]) => groupCategory === category) : groups.at(-1);
    if (group?.[0] === category) {
      group[1].push({ command, index });
    } else {
      groups.push([category, [{ command, index }]]);
    }
  }

  return html`
    <div id=${listboxId} class="slash-menu" role="listbox" aria-label=${t("chat.commands.menu")}>
      <div
        class="slash-menu__scroll"
        ${ref(syncComposerMenuScroll)}
        @scroll=${syncComposerMenuScrollEvent}
      >
        ${groups.map(
          ([category, entries]) => html`<div class="slash-menu-group">
            <div class="slash-menu-group__label">${getSlashCommandCategoryLabel(category)}</div>
            ${entries.map(({ command, index }) =>
              renderSlashCommandOption({
                cmd: command,
                index,
                query,
                requestUpdate,
                props,
                state,
              }),
            )}
          </div>`,
        )}
        ${skills.length > 0
          ? html`<div class="slash-menu-group slash-menu-group--skills">
              <div class="slash-menu-group__label">${t("chat.skills.label")}</div>
              ${skills.map((cmd, index) =>
                renderSlashCommandOption({
                  cmd,
                  index: commands.length + index,
                  query,
                  requestUpdate,
                  props,
                  state,
                }),
              )}
            </div>`
          : nothing}
      </div>
    </div>
  `;
}
