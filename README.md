# alma-generate-barcodes

Interactive CLI that fills in missing (and optionally repairs invalid) item barcodes for a set of physical items in [Ex Libris Alma](https://developers.exlibrisgroup.com/alma/apis/).

## What it does

1. Lists all sets of physical items (itemized and logical) and lets you pick one.
2. Lets you pick a strategy:
   - **Generate empty barcodes only** - items with an invalid barcode are left untouched.
   - **Generate empty and fix invalid barcodes** - also repairs invalid barcodes (strip non-digits, pad short ones, truncate long ones).
3. Fetches all items in the set, classifies their barcodes and shows a preview of the planned changes.
4. After confirmation, updates the items in Alma one by one.

A valid barcode is exactly 12 digits. Freshly generated barcodes start with `71` and are handed out sequentially, continuing from the last used barcode stored in the gitignored `.last-barcode` file next to the script. If that file is missing, you are prompted for a seed. Duplicate barcodes (both within the run and reported by Alma) are detected and retried with the next generated barcode.

## Requirements

- [Bun](https://bun.sh)
- An Alma API key with read/write access to the Bibs and Configuration APIs

## Setup

```sh
bun install
```

Create a `.env` file next to the script:

```sh
ALMA_API_KEY=your-api-key
# Optional, defaults to the EU region:
# ALMA_API_HOST=https://api-eu.hosted.exlibrisgroup.com
```

## Usage

```sh
bun run index.ts
```

Alternatively, register the command globally so it is available on your `PATH`:

```sh
bun link
alma-generate-barcodes
```

## Tests

```sh
bun test
```
