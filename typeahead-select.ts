import { SelectPrompt, settings, wrapTextWithPrefix } from "@clack/core";
import {
  S_BAR,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  formatInstructionFooter,
  limitOptions,
  symbol,
  symbolBar,
} from "@clack/prompts";
import { styleText } from "node:util";

/**
 * Typing letters should jump the list instead of moving the cursor, so drop
 * clack's vim-style navigation aliases (arrow keys still work everywhere).
 */
for (const alias of ["k", "j", "h", "l"]) settings.aliases.delete(alias);

export type TypeaheadOption<T> = {
  value: T;
  label: string;
  hint?: string;
};

/** Pause in typing after which the jump buffer starts over. */
const TYPEAHEAD_RESET_MS = 1500;

const INSTRUCTIONS = [
  `${styleText("dim", "↑/↓")} to navigate`,
  `${styleText("dim", "type")} to jump`,
  `${styleText("dim", "Enter:")} confirm`,
];

/**
 * A drop-in alternative to p.select: the full list stays visible, but typing
 * jumps the cursor to the first option whose label starts with (or, failing
 * that, contains) the typed text. Backspace edits the buffer; a short pause
 * resets it.
 */
export function typeaheadSelect<T>(opts: {
  message: string;
  options: TypeaheadOption<T>[];
  maxItems?: number;
  initialValue?: T;
}): Promise<T | symbol> {
  let typed = "";
  let lastKeyAt = 0;

  const formatOption = (
    option: TypeaheadOption<T> | undefined,
    state: "active" | "inactive" | "selected" | "cancelled",
  ): string => {
    if (option === undefined) return "";
    const label = option.label;
    const hint = option.hint
      ? ` ${styleText("dim", `(${option.hint})`)}`
      : "";
    switch (state) {
      case "active":
        return `${styleText("green", S_RADIO_ACTIVE)} ${label}${hint}`;
      case "selected":
        return styleText("dim", label);
      case "cancelled":
        return styleText(["strikethrough", "dim"], label);
      default:
        return `${styleText("dim", S_RADIO_INACTIVE)} ${styleText("dim", label)}`;
    }
  };

  const prompt = new SelectPrompt<TypeaheadOption<T>>({
    options: opts.options,
    initialValue: opts.initialValue,
    render() {
      const jump = typed
        ? ` ${styleText("dim", `(jump: ${typed})`)}`
        : "";
      const message = `${opts.message}${jump}`;
      const header =
        `${styleText("gray", S_BAR)}\n` +
        `${wrapTextWithPrefix(undefined, message, `${symbolBar(this.state)}  `, `${symbol(this.state)}  `)}\n`;

      switch (this.state) {
        case "submit": {
          const prefix = `${styleText("gray", S_BAR)}  `;
          return (
            header +
            wrapTextWithPrefix(
              undefined,
              formatOption(this.options[this.cursor], "selected"),
              prefix,
            )
          );
        }
        case "cancel": {
          const prefix = `${styleText("gray", S_BAR)}  `;
          return (
            header +
            wrapTextWithPrefix(
              undefined,
              formatOption(this.options[this.cursor], "cancelled"),
              prefix,
            ) +
            `\n${styleText("gray", S_BAR)}`
          );
        }
        default: {
          const prefix = `${styleText("cyan", S_BAR)}  `;
          const footer = formatInstructionFooter(INSTRUCTIONS, true);
          const body = limitOptions({
            cursor: this.cursor,
            options: this.options,
            maxItems: opts.maxItems,
            columnPadding: prefix.length,
            rowPadding: header.split("\n").length + footer.length + 1,
            style: (option, active) =>
              formatOption(option, active ? "active" : "inactive"),
          }).join(`\n${prefix}`);
          return `${header}${prefix}${body}\n${footer.join("\n")}\n`;
        }
      }
    },
  });

  prompt.on("key", (char, key) => {
    const name = key?.name ?? "";
    if (["up", "down", "left", "right", "return"].includes(name)) {
      typed = "";
      return;
    }

    const now = Date.now();
    if (now - lastKeyAt > TYPEAHEAD_RESET_MS) typed = "";
    lastKeyAt = now;

    if (name === "backspace") {
      typed = typed.slice(0, -1);
    } else if (
      char &&
      char.length === 1 &&
      char >= " " &&
      !key?.ctrl &&
      !key?.meta
    ) {
      typed += char.toLowerCase();
    } else {
      return;
    }
    if (!typed) return;

    const labels = opts.options.map((o) => o.label.toLowerCase());
    const prefixMatch = labels.findIndex((l) => l.startsWith(typed));
    const index =
      prefixMatch !== -1
        ? prefixMatch
        : labels.findIndex((l) => l.includes(typed));
    if (index !== -1) {
      prompt.cursor = index;
      prompt.value = opts.options[index]!.value;
    }
  });

  return prompt.prompt() as Promise<T | symbol>;
}
