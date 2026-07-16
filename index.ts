#!/usr/bin/env bun
import * as p from "@clack/prompts";
import {
  AlmaClient,
  isDuplicateBarcodeError,
  type AlmaItem,
  type AlmaSet,
} from "./alma.ts";
import {
  classifyBarcode,
  incrementBarcode,
  isValidGeneratorSeed,
} from "./barcode.ts";

const LAST_BARCODE_FILE = `${import.meta.dir}/.last-barcode`;
const MAX_DUPLICATE_RETRIES = 5;
const ITEM_FETCH_CONCURRENCY = 8;

type Strategy = "generate" | "fix";

type PlannedChange = {
  item: AlmaItem;
  oldBarcode: string;
  /** Repaired barcode; absent means a fresh barcode must be generated. */
  fixed?: string;
};

await loadEnvFromScriptDir();

let alma: AlmaClient;
try {
  alma = AlmaClient.fromEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

async function main() {
  p.intro("Alma generate barcodes");

  const set = await selectSet();
  const strategy = await selectStrategy();
  const items = await fetchItems(set);

  const { changes, valid, skippedInvalid } = planChanges(items, strategy);

  p.log.info(
    [
      `${items.length} item(s) checked: ${valid} valid`,
      `${changes.length} to update`,
      skippedInvalid > 0
        ? `${skippedInvalid} invalid but skipped (strategy: generate only)`
        : null,
    ]
      .filter(Boolean)
      .join(", "),
  );

  if (changes.length === 0) {
    p.outro("Nothing to do.");
    return;
  }

  previewChanges(changes);

  const confirmed = await p.confirm({
    message: `Update ${changes.length} item(s) in Alma?`,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled");
    process.exit(0);
  }

  const { ok, failed } = await applyChanges(changes, items);
  p.outro(`Done. ${ok} updated, ${failed} failed.`);
}

async function selectSet(): Promise<AlmaSet> {
  const sp = p.spinner();
  sp.start("Fetching sets of physical items…");
  let sets: AlmaSet[];
  try {
    sets = await alma.listItemSets();
    sp.stop(`Loaded ${sets.length} set(s) of physical items`);
  } catch (e) {
    sp.stop("Failed to fetch sets");
    p.cancel((e as Error).message);
    process.exit(1);
  }

  if (sets.length === 0) {
    p.cancel("No sets of physical items found.");
    process.exit(1);
  }

  sets.sort(byNewestFirst);

  const options = sets.map((s) => ({
    value: s.id,
    label: setLabel(s),
    hint: s.description || undefined,
  }));
  const optionById = new Map(options.map((o) => [o.value, o]));
  const stopFillingCounts = fillInMemberCounts(sets, optionById);

  const selected = await p.select({
    message: "Select a set",
    maxItems: 12,
    options,
  });
  stopFillingCounts();
  if (p.isCancel(selected)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return sets.find((s) => s.id === selected)!;
}

/**
 * The set list response omits member counts, so fetch each set's details in
 * the background while the select prompt is already open, patching the option
 * labels as counts come in. Clack repaints on terminal resize; faking a
 * resize event makes the updated labels visible without user input.
 */
function fillInMemberCounts(
  sets: AlmaSet[],
  optionById: Map<string, { label: string }>,
): () => void {
  let active = true;
  void (async () => {
    for (let i = 0; i < sets.length && active; i += ITEM_FETCH_CONCURRENCY) {
      const batch = sets.slice(i, i + ITEM_FETCH_CONCURRENCY);
      await Promise.all(
        batch.map(async (s) => {
          try {
            const detailed = await alma.getSet(s.id);
            s.number_of_members = detailed.number_of_members;
            const option = optionById.get(s.id);
            if (option) option.label = setLabel(s);
          } catch {
            // Leave the label without a count.
          }
        }),
      );
      if (active) process.stdout.emit("resize");
    }
  })();
  return () => {
    active = false;
  };
}

function setLabel(s: AlmaSet): string {
  return `${s.name} (${setKindLabel(s)}${memberCountLabel(s)})`;
}

function byNewestFirst(a: AlmaSet, b: AlmaSet): number {
  const dateA = a.created_date ? Date.parse(a.created_date) : NaN;
  const dateB = b.created_date ? Date.parse(b.created_date) : NaN;
  if (!Number.isNaN(dateA) && !Number.isNaN(dateB) && dateA !== dateB) {
    return dateB - dateA;
  }
  // Fall back to numeric id (Alma ids are increasing)
  return Number(b.id) - Number(a.id);
}

function setKindLabel(s: AlmaSet): string {
  const type = s.type?.value ?? "";
  if (type === "ITEMIZED") return "itemized";
  if (type === "LOGICAL") return "query";
  return type.toLowerCase() || "unknown";
}

function memberCountLabel(s: AlmaSet): string {
  const count = s.number_of_members?.value;
  if (count === undefined || count === null || count === "") return "";
  return `, ${count} items`;
}

async function selectStrategy(): Promise<Strategy> {
  const strategy = await p.select<Strategy>({
    message: "Select a strategy",
    options: [
      {
        value: "generate",
        label: "Generate empty barcodes only",
        hint: "items with an invalid barcode are left untouched",
      },
      {
        value: "fix",
        label: "Generate empty and fix invalid barcodes",
        hint: "pad short, truncate long, strip text",
      },
    ],
  });
  if (p.isCancel(strategy)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return strategy;
}

async function fetchItems(set: AlmaSet): Promise<AlmaItem[]> {
  const sp = p.spinner();
  sp.start("Fetching set members…");
  try {
    const members = await alma.listSetMembers(set.id, (fetched, total) =>
      sp.message(`Fetching set members… ${fetched}/${total}`),
    );
    const links = members
      .map((m) => m.link)
      .filter((l): l is string => Boolean(l));

    const items: AlmaItem[] = [];
    let fetchErrors = 0;
    for (let i = 0; i < links.length; i += ITEM_FETCH_CONCURRENCY) {
      const batch = links.slice(i, i + ITEM_FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (link) => {
          try {
            return await alma.getItem(link);
          } catch {
            fetchErrors++;
            return null;
          }
        }),
      );
      items.push(...results.filter((r): r is AlmaItem => r !== null));
      sp.message(
        `Fetching items… ${Math.min(i + batch.length, links.length)}/${links.length}`,
      );
    }

    sp.stop(
      `Loaded ${items.length} item(s)` +
        (fetchErrors > 0 ? ` (${fetchErrors} failed to fetch)` : ""),
    );
    if (items.length === 0) {
      p.cancel("The set contains no fetchable items.");
      process.exit(1);
    }
    return items;
  } catch (e) {
    sp.stop("Failed to fetch items");
    p.cancel((e as Error).message);
    process.exit(1);
  }
}

function planChanges(
  items: AlmaItem[],
  strategy: Strategy,
): { changes: PlannedChange[]; valid: number; skippedInvalid: number } {
  const changes: PlannedChange[] = [];
  let valid = 0;
  let skippedInvalid = 0;

  for (const item of items) {
    const oldBarcode = (item.item_data.barcode ?? "").trim();
    const classification = classifyBarcode(oldBarcode);
    switch (classification.kind) {
      case "valid":
        valid++;
        break;
      case "empty":
        changes.push({ item, oldBarcode });
        break;
      case "fixable":
        if (strategy === "fix") {
          changes.push({ item, oldBarcode, fixed: classification.fixed });
        } else {
          skippedInvalid++;
        }
        break;
      case "unfixable":
        if (strategy === "fix") {
          changes.push({ item, oldBarcode });
        } else {
          skippedInvalid++;
        }
        break;
    }
  }
  return { changes, valid, skippedInvalid };
}

function previewChanges(changes: PlannedChange[]) {
  const counts = new Map<string, number>();
  for (const change of changes) {
    const action = changeAction(change);
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const lines = [...counts].map(
    ([action, count]) => `${action}: ${count} item${count === 1 ? "" : "s"}`,
  );
  p.note(lines.join("\n"), "Planned changes");
}

function changeAction(c: PlannedChange): string {
  if (!c.fixed) {
    return c.oldBarcode
      ? "unfixable barcode -> new barcode"
      : "empty -> new barcode";
  }
  const digits = c.oldBarcode.replace(/\D+/g, "");
  const hasText = digits.length !== c.oldBarcode.length;
  if (digits.length > 12) {
    return hasText
      ? "long barcode with text -> stripped and truncated"
      : "long barcode -> truncated";
  }
  if (digits.length < 12) {
    return hasText
      ? "short barcode with text -> stripped and padded"
      : "short barcode -> padded";
  }
  return "barcode with text -> digits only";
}

function itemLabel(item: AlmaItem): string {
  const { pid, description } = item.item_data;
  return [item.bib_data.title, description, `pid ${pid}`]
    .filter(Boolean)
    .join(" | ");
}

async function applyChanges(
  changes: PlannedChange[],
  allItems: AlmaItem[],
): Promise<{ ok: number; failed: number }> {
  // Barcodes already present in the set; used to avoid in-run collisions.
  const used = new Set<string>();
  for (const item of allItems) {
    const b = (item.item_data.barcode ?? "").trim();
    if (b) used.add(b);
  }

  const counter = new BarcodeCounter();
  let ok = 0;
  let failed = 0;

  for (const change of changes) {
    try {
      const newBarcode = await applyChange(change, counter, used);
      p.log.success(
        `${change.oldBarcode || "(empty)"} -> ${newBarcode}  ${itemLabel(change.item)}`,
      );
      ok++;
    } catch (e) {
      if (e instanceof DuplicateRetriesExhausted) {
        p.cancel(
          `Gave up on ${itemLabel(change.item)}: ${MAX_DUPLICATE_RETRIES} generated barcodes were ` +
            `already taken (last tried: ${e.lastTried}). Update ${LAST_BARCODE_FILE} manually and rerun.`,
        );
        process.exit(1);
      }
      p.log.error(
        `${change.oldBarcode || "(empty)"}  ${itemLabel(change.item)} - ${(e as Error).message}`,
      );
      failed++;
    }
  }
  return { ok, failed };
}

class DuplicateRetriesExhausted extends Error {
  constructor(readonly lastTried: string) {
    super("Duplicate barcode retries exhausted");
  }
}

async function applyChange(
  change: PlannedChange,
  counter: BarcodeCounter,
  used: Set<string>,
): Promise<string> {
  let barcode: string;
  let generated: boolean;
  if (change.fixed && !used.has(change.fixed)) {
    barcode = change.fixed;
    generated = false;
  } else {
    barcode = await counter.next(used);
    generated = true;
  }

  let duplicateFailures = 0;
  while (true) {
    try {
      await alma.updateItemBarcode(change.item, barcode);
      used.add(barcode);
      if (generated) await counter.persist();
      return barcode;
    } catch (e) {
      if (!isDuplicateBarcodeError(e)) throw e;
      used.add(barcode); // exists in Alma, never try it again
      duplicateFailures++;
      if (duplicateFailures >= MAX_DUPLICATE_RETRIES) {
        throw new DuplicateRetriesExhausted(barcode);
      }
      // A repaired barcode that collides falls back to a generated one.
      barcode = await counter.next(used);
      generated = true;
    }
  }
}

/**
 * Hands out fresh "71"-prefixed barcodes, continuing from the last used
 * barcode stored in a gitignored text file next to this script.
 */
class BarcodeCounter {
  private last: string | null = null;

  async next(used: Set<string>): Promise<string> {
    if (this.last === null) {
      this.last = await this.loadOrPromptSeed();
    }
    for (let i = 0; i < 10_000; i++) {
      this.last = incrementBarcode(this.last);
      if (!used.has(this.last)) return this.last;
    }
    throw new Error("Could not find an unused generated barcode.");
  }

  async persist(): Promise<void> {
    if (this.last !== null) {
      await Bun.write(LAST_BARCODE_FILE, `${this.last}\n`);
    }
  }

  private async loadOrPromptSeed(): Promise<string> {
    const file = Bun.file(LAST_BARCODE_FILE);
    if (await file.exists()) {
      const stored = (await file.text()).trim();
      if (/^\d{12}$/.test(stored)) return stored;
      p.log.warn(
        `Ignoring invalid content of ${LAST_BARCODE_FILE}: "${stored}"`,
      );
    }

    const input = await p.text({
      message:
        "No valid last used barcode on file. Enter the last used generated barcode (12 digits, starts with 71):",
      placeholder: "710000000000",
      validate: (value) =>
        isValidGeneratorSeed(value ?? "")
          ? undefined
          : "Must be 12 digits starting with 71",
    });
    if (p.isCancel(input)) {
      p.cancel("Cancelled");
      process.exit(0);
    }
    return input;
  }
}

async function loadEnvFromScriptDir() {
  const file = Bun.file(`${import.meta.dir}/.env`);
  if (!(await file.exists())) return;
  const text = await file.text();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!value) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
