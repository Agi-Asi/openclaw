import { html, nothing } from "lit";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/modal-dialog.ts";
import { t } from "../../../i18n/index.ts";
import {
  getSlashCommandCategoryLabel,
  getSlashCommandCompletions,
  getSlashCommandDescription,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";

const categories: SlashCommandCategory[] = ["session", "model", "tools", "agents"];

function commandText(command: SlashCommandDef): string {
  return `/${command.name}${command.args ? ` ${command.args}` : ""}`;
}

export function renderCommandHelpDialog(params: {
  assistantName: string;
  category: SlashCommandCategory;
  query: string;
  selectedKey: string | null;
  onCategoryChange: (category: SlashCommandCategory) => void;
  onQueryChange: (query: string) => void;
  onSelect: (command: SlashCommandDef) => void;
  onAsk: (command: string) => void;
  onClose: () => void;
}) {
  const matchingCommands = getSlashCommandCompletions(params.query, { showAll: true });
  const commands = params.query.trim()
    ? matchingCommands
    : matchingCommands.filter((command) => (command.category ?? "session") === params.category);
  const selected = commands.find((command) => command.key === params.selectedKey) ?? commands[0];
  const title = t("chat.commands.help.title");
  const description = t("chat.commands.help.description");

  return html`
    <openclaw-modal-dialog
      class="command-help-dialog"
      label=${title}
      description=${description}
      @modal-cancel=${params.onClose}
    >
      <section class="command-help-dialog__card">
        <header class="command-help-dialog__header">
          <div>
            <h2>${title}</h2>
            <p>${description}</p>
          </div>
          <div class="command-help-dialog__header-actions">
            <a href="https://docs.openclaw.ai" target="_blank" rel="noreferrer">
              ${icons.book}<span>${t("chat.commands.help.docs")}</span>${icons.externalLink}
            </a>
            <button type="button" aria-label=${t("common.close")} @click=${params.onClose}>
              ${icons.x}
            </button>
          </div>
        </header>
        <label class="command-help-dialog__search">
          <span aria-hidden="true">${icons.search}</span>
          <span class="sr-only">${t("chat.commands.help.searchLabel")}</span>
          <input
            autofocus
            type="search"
            .value=${params.query}
            placeholder=${t("chat.commands.help.searchPlaceholder")}
            @input=${(event: InputEvent) => {
              params.onQueryChange((event.currentTarget as HTMLInputElement).value);
            }}
          />
        </label>
        <div class="command-help-dialog__tabs" role="tablist">
          ${categories.map(
            (category) => html`
              <button
                type="button"
                role="tab"
                aria-selected=${category === params.category}
                class=${category === params.category
                  ? "command-help-dialog__tab is-active"
                  : "command-help-dialog__tab"}
                @click=${() => params.onCategoryChange(category)}
              >
                ${getSlashCommandCategoryLabel(category)}
              </button>
            `,
          )}
        </div>
        <div class="command-help-dialog__body">
          <div
            class="command-help-dialog__list"
            aria-label=${params.query.trim()
              ? t("chat.commands.help.searchResults")
              : t("chat.commands.help.commandList", {
                  category: getSlashCommandCategoryLabel(params.category),
                })}
          >
            ${commands.length === 0
              ? html`<p class="command-help-dialog__empty">${t("chat.commands.help.noResults")}</p>`
              : commands.map(
                  (command) => html`
                    <button
                      type="button"
                      class=${command === selected
                        ? "command-help-dialog__command is-selected"
                        : "command-help-dialog__command"}
                      @click=${() => params.onSelect(command)}
                    >
                      <span class="command-help-dialog__command-copy">
                        <strong>/${command.name}</strong>
                        ${command.args ? html`<span>${command.args}</span>` : nothing}
                      </span>
                      <span class="command-help-dialog__command-summary">
                        ${params.query.trim()
                          ? html`<small
                              >${getSlashCommandCategoryLabel(command.category ?? "session")}</small
                            >`
                          : nothing}
                        <span>${getSlashCommandDescription(command)}</span>
                      </span>
                    </button>
                  `,
                )}
          </div>
          ${selected
            ? html`
                <aside class="command-help-dialog__detail">
                  <div class="command-help-dialog__detail-command">
                    <code>${commandText(selected)}</code>
                    ${renderCopyButton(
                      commandText(selected),
                      t("chat.commands.help.copy", { command: commandText(selected) }),
                    )}
                  </div>
                  <p>${getSlashCommandDescription(selected)}</p>
                  <button
                    type="button"
                    class="btn primary command-help-dialog__ask"
                    @click=${() => params.onAsk(commandText(selected))}
                  >
                    ${icons.messageSquare}
                    <span
                      >${t("chat.commands.help.ask", {
                        agent: params.assistantName || "OpenClaw",
                      })}</span
                    >
                  </button>
                </aside>
              `
            : nothing}
        </div>
      </section>
    </openclaw-modal-dialog>
  `;
}
